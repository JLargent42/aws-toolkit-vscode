/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * This class is responsible for responding to UI events by calling
 * the Gumby extension.
 */
import nodefs from 'fs'
import path from 'path'
import * as vscode from 'vscode'
import { GumbyNamedMessages, Messenger } from './messenger/messenger'
import { AuthController } from '../../../amazonq/auth/controller'
import { ChatSessionManager } from '../storages/chatSession'
import { ConversationState, Session } from '../session/session'
import { getLogger } from '../../../shared/logger'
import { featureName } from '../../models/constants'
import { AuthUtil } from '../../../codewhisperer/util/authUtil'
import {
    cleanupTransformationJob,
    compileProject,
    finishHumanInTheLoop,
    getValidCandidateProjects,
    openBuildLogFile,
    openHilPomFile,
    parseBuildFile,
    postTransformationJob,
    processTransformFormInput,
    startTransformByQ,
    stopTransformByQ,
    validateCanCompileProject,
    setMaven,
} from '../../../codewhisperer/commands/startTransformByQ'
import { JDKVersion, TransformationCandidateProject, transformByQState } from '../../../codewhisperer/models/model'
import {
    AbsolutePathDetectedError,
    AlternateDependencyVersionsNotFoundError,
    JavaHomeNotSetError,
    JobStartError,
    ModuleUploadError,
    NoJavaProjectsFoundError,
    NoMavenJavaProjectsFoundError,
    TransformationPreBuildError,
} from '../../errors'
import * as CodeWhispererConstants from '../../../codewhisperer/models/constants'
import MessengerUtils, { ButtonActions, GumbyCommands } from './messenger/messengerUtils'
import { CancelActionPositions, JDKToTelemetryValue, telemetryUndefined } from '../../telemetry/codeTransformTelemetry'
import { openUrl } from '../../../shared/utilities/vsCodeUtils'
import {
    telemetry,
    CodeTransformJavaTargetVersionsAllowed,
    CodeTransformJavaSourceVersionsAllowed,
} from '../../../shared/telemetry/telemetry'
import { MetadataResult } from '../../../shared/telemetry/telemetryClient'
import { CodeTransformTelemetryState } from '../../telemetry/codeTransformTelemetryState'
import { getAuthType } from '../../../codewhisperer/service/transformByQ/transformApiHandler'
import DependencyVersions from '../../models/dependencies'
import { getStringHash } from '../../../shared/utilities/textUtilities'
import { getVersionData } from '../../../codewhisperer/service/transformByQ/transformMavenHandler'

// These events can be interactions within the chat,
// or elsewhere in the IDE
export interface ChatControllerEventEmitters {
    readonly transformSelected: vscode.EventEmitter<any>
    readonly tabOpened: vscode.EventEmitter<any>
    readonly tabClosed: vscode.EventEmitter<any>
    readonly authClicked: vscode.EventEmitter<any>
    readonly formActionClicked: vscode.EventEmitter<any>
    readonly commandSentFromIDE: vscode.EventEmitter<any>
    readonly transformationFinished: vscode.EventEmitter<any>
    readonly processHumanChatMessage: vscode.EventEmitter<any>
    readonly linkClicked: vscode.EventEmitter<any>
    readonly humanInTheLoopStartIntervention: vscode.EventEmitter<any>
    readonly humanInTheLoopPromptUserForDependency: vscode.EventEmitter<any>
    readonly humanInTheLoopSelectionUploaded: vscode.EventEmitter<any>
    readonly errorThrown: vscode.EventEmitter<any>
}

export class GumbyController {
    private readonly messenger: Messenger
    private readonly sessionStorage: ChatSessionManager
    private authController: AuthController

    public constructor(
        private readonly chatControllerMessageListeners: ChatControllerEventEmitters,
        messenger: Messenger,
        onDidChangeAmazonQVisibility: vscode.Event<boolean>
    ) {
        this.messenger = messenger
        this.sessionStorage = ChatSessionManager.Instance
        this.authController = new AuthController()

        this.chatControllerMessageListeners.transformSelected.event((data) => {
            return this.transformInitiated(data)
        })

        this.chatControllerMessageListeners.tabOpened.event((data) => {
            return this.tabOpened(data)
        })

        this.chatControllerMessageListeners.tabClosed.event((data) => {
            return this.tabClosed(data)
        })

        this.chatControllerMessageListeners.authClicked.event((data) => {
            this.authClicked(data)
        })

        this.chatControllerMessageListeners.commandSentFromIDE.event((data) => {
            return this.commandSentFromIDE(data)
        })

        this.chatControllerMessageListeners.formActionClicked.event((data) => {
            return this.formActionClicked(data)
        })

        this.chatControllerMessageListeners.transformationFinished.event((data) => {
            return this.transformationFinished(data)
        })

        this.chatControllerMessageListeners.processHumanChatMessage.event((data) => {
            return this.processHumanChatMessage(data)
        })

        this.chatControllerMessageListeners.linkClicked.event((data) => {
            this.openLink(data)
        })

        this.chatControllerMessageListeners.humanInTheLoopStartIntervention.event((data) => {
            return this.startHILIntervention(data)
        })

        this.chatControllerMessageListeners.humanInTheLoopPromptUserForDependency.event((data) => {
            return this.HILPromptForDependency(data)
        })

        this.chatControllerMessageListeners.humanInTheLoopSelectionUploaded.event((data) => {
            return this.HILDependencySelectionUploaded(data)
        })

        this.chatControllerMessageListeners.errorThrown.event((data) => {
            return this.handleError(data)
        })
    }

    private async tabOpened(message: any) {
        const session: Session = this.sessionStorage.getSession()
        const tabID = this.sessionStorage.setActiveTab(message.tabID)

        // check if authentication has expired
        try {
            getLogger().debug(`${featureName}: Session created with id: ${session.tabID}`)

            const authState = await AuthUtil.instance.getChatAuthState()
            if (authState.amazonQ !== 'connected') {
                void this.messenger.sendAuthNeededExceptionMessage(authState, tabID)
                session.isAuthenticating = true
                return
            }
        } catch (err: any) {
            this.messenger.sendErrorMessage(err.message, message.tabID)
        }
    }

    private async tabClosed(data: any) {
        this.sessionStorage.removeActiveTab()
    }

    private authClicked(message: any) {
        this.authController.handleAuth(message.authType)

        this.messenger.sendAnswer({
            type: 'answer',
            tabID: message.tabID,
            message: 'Follow instructions to re-authenticate ...',
        })

        // Explicitly ensure the user goes through the re-authenticate flow
        this.messenger.sendChatInputEnabled(message.tabID, false)
    }

    private commandSentFromIDE(data: any): any {
        this.messenger.sendCommandMessage(data)
    }

    private async transformInitiated(message: any) {
        // Start /transform chat flow
        const session: Session = this.sessionStorage.getSession()
        CodeTransformTelemetryState.instance.setSessionId()

        try {
            await telemetry.codeTransform_initiateTransform.run(async () => {
                const authType = await getAuthType()
                telemetry.record({
                    codeTransformSessionId: CodeTransformTelemetryState.instance.getSessionId(),
                    credentialSourceId: authType,
                })

                // check that a project is open
                const workspaceFolders = vscode.workspace.workspaceFolders
                if (workspaceFolders === undefined || workspaceFolders.length === 0) {
                    this.messenger.sendUnrecoverableErrorResponse('no-project-found', message.tabID)
                    telemetry.record({ result: MetadataResult.Fail, reason: 'no-project-found' })
                    return
                }

                // check that the session is authenticated
                const authState = await AuthUtil.instance.getChatAuthState()
                if (authState.amazonQ !== 'connected') {
                    void this.messenger.sendAuthNeededExceptionMessage(authState, message.tabID)
                    session.isAuthenticating = true
                    telemetry.record({ result: MetadataResult.Fail, reason: 'auth-failed' })
                    return
                }

                // If previous transformation was already running
                switch (this.sessionStorage.getSession().conversationState) {
                    case ConversationState.JOB_SUBMITTED:
                        this.messenger.sendAsyncEventProgress(
                            message.tabID,
                            true,
                            undefined,
                            GumbyNamedMessages.JOB_SUBMISSION_STATUS_MESSAGE
                        )
                        this.messenger.sendJobSubmittedMessage(message.tabID)
                        return
                    case ConversationState.COMPILING:
                        this.messenger.sendAsyncEventProgress(
                            message.tabID,
                            true,
                            undefined,
                            GumbyNamedMessages.COMPILATION_PROGRESS_MESSAGE
                        )
                        this.messenger.sendCompilationInProgress(message.tabID)
                        return
                }
                this.messenger.sendTransformationIntroduction(message.tabID)
            })
        } catch (e: any) {
            // if there was an issue getting the list of valid projects, the error message will be shown here
            this.messenger.sendErrorMessage(e.message, message.tabID)
        }

        try {
            const validProjects = await this.validateProjectsWithReplyOnError(message)
            if (validProjects.length > 0) {
                this.sessionStorage.getSession().updateCandidateProjects(validProjects)
                await this.messenger.sendProjectPrompt(validProjects, message.tabID)
            }
        } catch (err: any) {
            // if there was an issue getting the list of valid projects, the error message will be shown here
            this.messenger.sendErrorMessage(err.message, message.tabID)
        }
    }

    private async validateProjectsWithReplyOnError(message: any): Promise<TransformationCandidateProject[]> {
        let telemetryJavaVersion = JDKToTelemetryValue(JDKVersion.UNSUPPORTED) as CodeTransformJavaSourceVersionsAllowed
        try {
            const validProjects = await telemetry.codeTransform_validateProject.run(async () => {
                telemetry.record({
                    codeTransformBuildSystem: 'Maven', // default for Maven until we add undefined field to CodeTransformBuildSystem
                    codeTransformSessionId: CodeTransformTelemetryState.instance.getSessionId(),
                })

                const validProjects = await getValidCandidateProjects()
                if (validProjects.length > 0) {
                    // validProjects[0].JDKVersion will be undefined if javap errors out or no .class files found, so call it UNSUPPORTED
                    const javaVersion = validProjects[0].JDKVersion ?? JDKVersion.UNSUPPORTED
                    telemetryJavaVersion = JDKToTelemetryValue(javaVersion) as CodeTransformJavaSourceVersionsAllowed
                }
                telemetry.record({ codeTransformLocalJavaVersion: telemetryJavaVersion })

                await setMaven()
                const versionInfo = await getVersionData()
                const mavenVersionInfoMessage = `${versionInfo[0]} (${transformByQState.getMavenName()})`
                telemetry.record({ buildSystemVersion: mavenVersionInfoMessage })

                return validProjects
            })
            return validProjects
        } catch (e: any) {
            if (e instanceof NoJavaProjectsFoundError) {
                this.messenger.sendUnrecoverableErrorResponse('no-java-project-found', message.tabID)
            } else if (e instanceof NoMavenJavaProjectsFoundError) {
                this.messenger.sendUnrecoverableErrorResponse('no-maven-java-project-found', message.tabID)
            } else {
                this.messenger.sendUnrecoverableErrorResponse('no-project-found', message.tabID)
            }
        }
        return []
    }

    private async formActionClicked(message: any) {
        const typedAction = MessengerUtils.stringToEnumValue(ButtonActions, message.action as any)
        switch (typedAction) {
            case ButtonActions.CONFIRM_TRANSFORMATION_FORM:
                await this.handleUserProjectSelection(message)
                break
            case ButtonActions.CANCEL_TRANSFORMATION_FORM:
                telemetry.codeTransform_submitSelection.emit({
                    codeTransformSessionId: CodeTransformTelemetryState.instance.getSessionId(),
                    userChoice: 'Cancel',
                    result: MetadataResult.Pass,
                })
                this.messenger.sendJobFinishedMessage(message.tabID, CodeWhispererConstants.jobCancelledChatMessage)
                break
            case ButtonActions.CONFIRM_SKIP_TESTS_FORM:
                await this.handleSkipTestsSelection(message)
                break
            case ButtonActions.CANCEL_SKIP_TESTS_FORM:
                this.messenger.sendJobFinishedMessage(message.tabID, CodeWhispererConstants.jobCancelledChatMessage)
                break
            case ButtonActions.VIEW_TRANSFORMATION_HUB:
                await vscode.commands.executeCommand(GumbyCommands.FOCUS_TRANSFORMATION_HUB, CancelActionPositions.Chat)
                this.messenger.sendJobSubmittedMessage(message.tabID)
                break
            case ButtonActions.STOP_TRANSFORMATION_JOB:
                await stopTransformByQ(transformByQState.getJobId(), CancelActionPositions.Chat)
                await postTransformationJob()
                await cleanupTransformationJob()
                break
            case ButtonActions.CONFIRM_START_TRANSFORMATION_FLOW:
                this.resetTransformationChatFlow()
                this.messenger.sendCommandMessage({ ...message, command: GumbyCommands.CLEAR_CHAT })
                await this.transformInitiated(message)
                break
            case ButtonActions.CONFIRM_DEPENDENCY_FORM:
                await this.continueJobWithSelectedDependency(message)
                break
            case ButtonActions.CANCEL_DEPENDENCY_FORM:
                this.messenger.sendUserPrompt('Cancel', message.tabID)
                await this.continueTransformationWithoutHIL(message)
                break
            case ButtonActions.OPEN_FILE:
                await openHilPomFile()
                break
            case ButtonActions.OPEN_BUILD_LOG:
                await openBuildLogFile()
                this.messenger.sendViewBuildLog(message.tabID)
                break
        }
    }

    private async handleSkipTestsSelection(message: any) {
        const skipTestsSelection = message.formSelectedValues['GumbyTransformSkipTestsForm']
        if (skipTestsSelection === CodeWhispererConstants.skipUnitTestsMessage) {
            transformByQState.setCustomBuildCommand(CodeWhispererConstants.skipUnitTestsBuildCommand)
        } else {
            transformByQState.setCustomBuildCommand(CodeWhispererConstants.doNotSkipUnitTestsBuildCommand)
        }
        telemetry.codeTransform_submitSelection.emit({
            codeTransformSessionId: CodeTransformTelemetryState.instance.getSessionId(),
            userChoice: skipTestsSelection,
            result: MetadataResult.Pass,
        })
        this.messenger.sendSkipTestsSelectionMessage(skipTestsSelection, message.tabID)
        // perform local build
        await this.validateBuildWithPromptOnError(message)
    }

    // prompt user to pick project and specify source JDK version
    private async handleUserProjectSelection(message: any) {
        await telemetry.codeTransform_submitSelection.run(async () => {
            const pathToProject: string = message.formSelectedValues['GumbyTransformProjectForm']
            const toJDKVersion: JDKVersion = message.formSelectedValues['GumbyTransformJdkToForm']
            const fromJDKVersion: JDKVersion = message.formSelectedValues['GumbyTransformJdkFromForm']

            telemetry.record({
                codeTransformJavaSourceVersionsAllowed: JDKToTelemetryValue(
                    fromJDKVersion
                ) as CodeTransformJavaSourceVersionsAllowed,
                codeTransformJavaTargetVersionsAllowed: JDKToTelemetryValue(
                    toJDKVersion
                ) as CodeTransformJavaTargetVersionsAllowed,
                codeTransformProjectId: pathToProject === undefined ? telemetryUndefined : getStringHash(pathToProject),
                userChoice: 'Confirm',
            })

            const projectName = path.basename(pathToProject)
            this.messenger.sendProjectSelectionMessage(projectName, fromJDKVersion, toJDKVersion, message.tabID)

            if (fromJDKVersion === JDKVersion.UNSUPPORTED) {
                this.messenger.sendUnrecoverableErrorResponse('unsupported-source-jdk-version', message.tabID)
                telemetry.record({
                    result: MetadataResult.Fail,
                    reason: 'unsupported-source-jdk-version',
                })
                return
            }

            await processTransformFormInput(pathToProject, fromJDKVersion, toJDKVersion)

            // TODO: delete this line when backend issue is fixed
            await this.validateBuildWithPromptOnError(message)

            // TODO: un-comment this line when backend issue is fixed
            // await this.messenger.sendSkipTestsPrompt(message.tabID)
        })
    }

    private async prepareProjectForSubmission(message: { pathToJavaHome: string; tabID: string }): Promise<void> {
        if (message.pathToJavaHome) {
            transformByQState.setJavaHome(message.pathToJavaHome)
            getLogger().info(
                `CodeTransformation: using JAVA_HOME = ${transformByQState.getJavaHome()} since source JDK does not match Maven JDK`
            )
        }

        // Pre-build project locally
        try {
            this.sessionStorage.getSession().conversationState = ConversationState.COMPILING
            this.messenger.sendCompilationInProgress(message.tabID)
            await compileProject()
        } catch (err: any) {
            this.messenger.sendUnrecoverableErrorResponse('could-not-compile-project', message.tabID)
            // reset state to allow "Start a new transformation" button to work
            this.sessionStorage.getSession().conversationState = ConversationState.IDLE
            throw err
        }

        this.messenger.sendCompilationFinished(message.tabID)

        const authState = await AuthUtil.instance.getChatAuthState()
        if (authState.amazonQ !== 'connected') {
            void this.messenger.sendAuthNeededExceptionMessage(authState, message.tabID)
            this.sessionStorage.getSession().isAuthenticating = true
            return
        }

        // give user a non-blocking warning if build file appears to contain absolute paths
        await parseBuildFile()

        this.messenger.sendAsyncEventProgress(
            message.tabID,
            true,
            undefined,
            GumbyNamedMessages.JOB_SUBMISSION_STATUS_MESSAGE
        )
        this.messenger.sendJobSubmittedMessage(message.tabID)
        this.sessionStorage.getSession().conversationState = ConversationState.JOB_SUBMITTED
        await startTransformByQ()
    }

    private async validateBuildWithPromptOnError(message: any | undefined = undefined): Promise<void> {
        try {
            // Check Java Home is set (not yet prebuilding)
            await validateCanCompileProject()
        } catch (err: any) {
            if (err instanceof JavaHomeNotSetError) {
                this.sessionStorage.getSession().conversationState = ConversationState.PROMPT_JAVA_HOME
                this.messenger.sendStaticTextResponse('java-home-not-set', message.tabID)
                this.messenger.sendChatInputEnabled(message.tabID, true)
                this.messenger.sendUpdatePlaceholder(message.tabID, 'Enter the path to your Java installation.')
                return
            }
            throw err
        }

        await this.prepareProjectForSubmission(message)
    }

    private transformationFinished(data: { message: string | undefined; tabID: string }) {
        this.resetTransformationChatFlow()
        // at this point job is either completed, partially_completed, cancelled, or failed
        if (data.message) {
            this.messenger.sendJobFinishedMessage(data.tabID, data.message)
        }
    }

    private resetTransformationChatFlow() {
        this.sessionStorage.getSession().conversationState = ConversationState.IDLE
    }

    private startHILIntervention(data: { tabID: string; codeSnippet: string }) {
        this.sessionStorage.getSession().conversationState = ConversationState.WAITING_FOR_INPUT
        this.messenger.sendHumanInTheLoopInitialMessage(data.tabID, data.codeSnippet)
    }

    private HILPromptForDependency(data: { tabID: string; dependencies: DependencyVersions }) {
        this.messenger.sendDependencyVersionsFoundMessage(data.dependencies, data.tabID)
    }

    private HILDependencySelectionUploaded(data: { tabID: string }) {
        this.sessionStorage.getSession().conversationState = ConversationState.JOB_SUBMITTED
        this.messenger.sendHILResumeMessage(data.tabID)
    }

    private async processHumanChatMessage(data: { message: string; tabID: string }) {
        this.messenger.sendUserPrompt(data.message, data.tabID)
        this.messenger.sendChatInputEnabled(data.tabID, false)
        this.messenger.sendUpdatePlaceholder(data.tabID, 'Open a new tab to chat with Q')

        const session = this.sessionStorage.getSession()
        switch (session.conversationState) {
            case ConversationState.PROMPT_JAVA_HOME: {
                const pathToJavaHome = extractPath(data.message)

                if (pathToJavaHome) {
                    await this.prepareProjectForSubmission({
                        pathToJavaHome,
                        tabID: data.tabID,
                    })
                } else {
                    this.messenger.sendUnrecoverableErrorResponse('invalid-java-home', data.tabID)
                }
            }
        }
    }

    private async continueJobWithSelectedDependency(message: { tabID: string; formSelectedValues: any }) {
        const selectedDependency = message.formSelectedValues['GumbyTransformDependencyForm']
        this.messenger.sendHILContinueMessage(message.tabID, selectedDependency)
        await finishHumanInTheLoop(selectedDependency)
    }

    private openLink(message: { link: string }) {
        void openUrl(vscode.Uri.parse(message.link))
    }

    private async handleError(message: { error: Error; tabID: string }) {
        if (message.error instanceof AlternateDependencyVersionsNotFoundError) {
            this.messenger.sendKnownErrorResponse(message.tabID, CodeWhispererConstants.dependencyVersionsErrorMessage)
            await this.continueTransformationWithoutHIL(message)
        } else if (message.error instanceof ModuleUploadError) {
            this.resetTransformationChatFlow()
        } else if (message.error instanceof JobStartError) {
            this.resetTransformationChatFlow()
        } else if (message.error instanceof TransformationPreBuildError) {
            this.messenger.sendJobSubmittedMessage(message.tabID, true)
            this.messenger.sendAsyncEventProgress(
                message.tabID,
                true,
                undefined,
                GumbyNamedMessages.JOB_FAILED_IN_PRE_BUILD
            )
            await openBuildLogFile()
            this.messenger.sendViewBuildLog(message.tabID)
        } else if (message.error instanceof AbsolutePathDetectedError) {
            this.messenger.sendKnownErrorResponse(message.tabID, message.error.message)
        }
    }

    private async continueTransformationWithoutHIL(message: { tabID: string }) {
        this.sessionStorage.getSession().conversationState = ConversationState.JOB_SUBMITTED
        CodeTransformTelemetryState.instance.setCodeTransformMetaDataField({
            canceledFromChat: true,
        })
        try {
            await finishHumanInTheLoop()
        } catch (err: any) {
            this.transformationFinished({ tabID: message.tabID, message: (err as Error).message })
        }

        this.messenger.sendStaticTextResponse('end-HIL-early', message.tabID)
    }
}

/**
 * Examples:
 * ```
 * extractPath("./some/path/here") => "C:/some/root/some/path/here"
 * extractPath(" ./some/path/here\n") => "C:/some/root/some/path/here"
 * extractPath("C:/some/nonexistent/path/here") => undefined
 * extractPath("C:/some/filepath/.txt") => undefined
 * ```
 *
 * @param text
 * @returns the absolute path if path points to existing folder, otherwise undefined
 */
function extractPath(text: string): string | undefined {
    const resolvedPath = path.resolve(text.trim())
    return nodefs.existsSync(resolvedPath) ? resolvedPath : undefined
}
