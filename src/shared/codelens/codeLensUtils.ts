/*!
 * Copyright 2018-2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'path'
import * as vscode from 'vscode'

import { detectLocalTemplates } from '../../lambda/local/detectLocalTemplates'
import { CloudFormation } from '../cloudformation/cloudformation'
import { LambdaHandlerCandidate } from '../lambdaHandlerSearch'
import { getLogger } from '../logger'
import { localize } from '../utilities/vsCodeUtils'
import * as pythonDebug from './pythonCodeLensProvider'
import * as csharpDebug from './csharpCodeLensProvider'
import * as tsDebug from './typescriptCodeLensProvider'
import { SettingsConfiguration } from '../settingsConfiguration'
import { LambdaLocalInvokeParams } from './localLambdaRunner'
import { ExtContext } from '../extensions'
import { recordLambdaInvokeLocal, Result, Runtime } from '../telemetry/telemetry'
import { TypescriptLambdaHandlerSearch } from '../typescriptLambdaHandlerSearch'
import { nodeJsRuntimes } from '../../lambda/models/samLambdaRuntime'
import { dirnameWithTrailingSlash } from '../utilities/pathUtils'
import { isInDirectory } from '../filesystemUtilities'

export type Language = 'python' | 'javascript' | 'csharp'

interface MakeConfigureCodeLensParams {
    document: vscode.TextDocument
    handlerName: string
    range: vscode.Range
    workspaceFolder: vscode.WorkspaceFolder
    language: Language
}

export async function makeCodeLenses({
    document,
    token,
    handlers,
    language,
}: {
    document: vscode.TextDocument
    token: vscode.CancellationToken
    handlers: LambdaHandlerCandidate[]
    language: Language
}): Promise<vscode.CodeLens[]> {
    const workspaceFolder: vscode.WorkspaceFolder | undefined = vscode.workspace.getWorkspaceFolder(document.uri)

    if (!workspaceFolder) {
        throw new Error(`Source file ${document.uri} is external to the current workspace.`)
    }

    const lenses: vscode.CodeLens[] = []
    for (const handler of handlers) {
        // handler.range is a RangeOrCharOffset union type. Extract vscode.Range.
        const range =
            handler.range instanceof vscode.Range
                ? handler.range
                : new vscode.Range(
                      document.positionAt(handler.range.positionStart),
                      document.positionAt(handler.range.positionEnd)
                  )

        try {
            const baseParams: MakeConfigureCodeLensParams = {
                document,
                handlerName: handler.handlerName,
                range,
                workspaceFolder,
                language,
            }
            lenses.push(makeLocalInvokeCodeLens({ ...baseParams, isDebug: false }))
            lenses.push(makeLocalInvokeCodeLens({ ...baseParams, isDebug: true }))
        } catch (err) {
            getLogger().error(
                `Could not generate 'configure' code lens for handler '${handler.handlerName}'`,
                err as Error
            )
        }
    }

    return lenses
}

export function getInvokeCmdKey(language: Language) {
    return `aws.lambda.local.invoke.${language}`
}

// TODO: Morph into new debug config codelens
function makeLocalInvokeCodeLens(
    params: MakeConfigureCodeLensParams & { isDebug: boolean; language: Language }
): vscode.CodeLens {
    const title: string = params.isDebug
        ? localize('AWS.codelens.lambda.invoke.debug', 'Debug Locally')
        : localize('AWS.codelens.lambda.invoke', 'Run Locally')

    const command: vscode.Command = {
        arguments: [params],
        command: getInvokeCmdKey(params.language),
        title,
    }

    return new vscode.CodeLens(params.range, command)
}

// TODO: Keep around if we want a linkage back to the template file?
// async function getAssociatedSamTemplate(
//     documentUri: vscode.Uri,
//     workspaceFolderUri: vscode.Uri,
//     handlerName: string
// ): Promise<vscode.Uri> {
//     const templates = detectLocalTemplates({
//         workspaceUris: [workspaceFolderUri],
//     })

//     for await (const template of templates) {
//         try {
//             // Throws if template does not contain a resource for this handler.
//             await CloudFormation.getResourceFromTemplate({
//                 templatePath: template.fsPath,
//                 handlerName,
//             })
//         } catch {
//             continue
//         }

//         // If there are multiple matching templates, use the first one.
//         return template
//     }

//     throw new Error(`Cannot find a SAM template associated with handler '${handlerName}' in: ${documentUri.fsPath}.`)
// }

export async function makePythonCodeLensProvider(
    pythonSettings: SettingsConfiguration
): Promise<vscode.CodeLensProvider> {
    const logger = getLogger()

    return {
        // CodeLensProvider
        provideCodeLenses: async (
            document: vscode.TextDocument,
            token: vscode.CancellationToken
        ): Promise<vscode.CodeLens[]> => {
            // Try to activate the Python Extension before requesting symbols from a python file
            await pythonDebug.activatePythonExtensionIfInstalled()
            if (token.isCancellationRequested) {
                return []
            }

            const handlers: LambdaHandlerCandidate[] = await pythonDebug.getLambdaHandlerCandidates(document.uri)
            logger.debug(
                'pythonCodeLensProvider.makePythonCodeLensProvider handlers:',
                JSON.stringify(handlers, undefined, 2)
            )

            return makeCodeLenses({
                document,
                handlers,
                token,
                language: 'python',
            })
        },
    }
}

export async function makeCSharpCodeLensProvider(): Promise<vscode.CodeLensProvider> {
    const logger = getLogger()

    const codeLensProvider: vscode.CodeLensProvider = {
        provideCodeLenses: async (
            document: vscode.TextDocument,
            token: vscode.CancellationToken
        ): Promise<vscode.CodeLens[]> => {
            const handlers: LambdaHandlerCandidate[] = await csharpDebug.getLambdaHandlerCandidates(document)
            logger.debug('makeCSharpCodeLensProvider handlers:', JSON.stringify(handlers, undefined, 2))

            return makeCodeLenses({
                document,
                handlers,
                token,
                language: 'csharp',
            })
        },
    }

    return codeLensProvider
}

export function makeTypescriptCodeLensProvider(): vscode.CodeLensProvider {
    return {
        provideCodeLenses: async (
            document: vscode.TextDocument,
            token: vscode.CancellationToken
        ): Promise<vscode.CodeLens[]> => {
            const search: TypescriptLambdaHandlerSearch = new TypescriptLambdaHandlerSearch(
                document.uri.fsPath,
                document.getText()
            )
            const unprocessedHandlers: LambdaHandlerCandidate[] = await search.findCandidateLambdaHandlers()

            // For Javascript CodeLenses, store the complete relative pathed handler name
            // (eg: src/app.handler) instead of only the pure handler name (eg: app.handler)
            // Without this, the CodeLens command is unable to resolve a match back to a sam template.
            // This is done to address https://github.com/aws/aws-toolkit-vscode/issues/757
            const handlers = await tsDebug.decorateHandlerNames(unprocessedHandlers, document.uri)

            return makeCodeLenses({
                document,
                handlers,
                token,
                language: 'javascript',
            })
        },
    }
}

export async function initializePythonCodelens(context: ExtContext): Promise<void> {
    context.subscriptions.push(
        vscode.commands.registerCommand(
            getInvokeCmdKey('python'),
            async (params: LambdaLocalInvokeParams): Promise<void> => {
                // TODO: restore or remove
            }
        )
    )
}

export async function initializeCsharpCodelens(context: ExtContext): Promise<void> {
    context.subscriptions.push(
        vscode.commands.registerCommand(
            getInvokeCmdKey(csharpDebug.CSHARP_LANGUAGE),
            async (params: LambdaLocalInvokeParams) => {
                // await csharpDebug.invokeCsharpLambda({
                //     ctx: context,
                //     config: undefined,
                //     lambdaLocalInvokeParams: params,
                // })
            }
        )
    )
}

/**
 * LEGACY/DEPRECATED codelens-based debug entrypoint.
 */
export function initializeTypescriptCodelens(context: ExtContext): void {
    // const processInvoker = new DefaultValidatingSamCliProcessInvoker({}),
    // const localInvokeCommand = new DefaultSamLocalInvokeCommand(getChannelLogger(context.outputChannel), [
    //     WAIT_FOR_DEBUGGER_MESSAGES.NODEJS
    // ])
    const invokeLambda = async (params: LambdaLocalInvokeParams & { runtime: string }) => {
        // const samProjectCodeRoot = await getSamProjectDirPathForFile(params.uri.fsPath)
        // let debugPort: number | undefined
        // if (params.isDebug) {
        //     debugPort = await getStartPort()
        // }
        // const debugConfig: NodejsDebugConfiguration = {
        //     type: 'node',
        //     request: 'attach',
        //     name: 'SamLocalDebug',
        //     preLaunchTask: undefined,
        //     address: 'localhost',
        //     port: debugPort!,
        //     localRoot: samProjectCodeRoot,
        //     remoteRoot: '/var/task',
        //     protocol: 'inspector',
        //     skipFiles: ['/var/runtime/node_modules/**/*.js', '<node_internals>/**/*.js']
        // }
        // const localLambdaRunner: LocalLambdaRunner = new LocalLambdaRunner(
        //     configuration,
        //     params,
        //     debugPort,
        //     params.runtime,
        //     toolkitOutputChannel,
        //     processInvoker,
        //     localInvokeCommand,
        //     debugConfig,
        //     samProjectCodeRoot,
        //     telemetryService
        // )
        // await localLambdaRunner.run()
    }

    const command = getInvokeCmdKey('javascript')
    context.subscriptions.push(
        vscode.commands.registerCommand(command, async (params: LambdaLocalInvokeParams) => {
            const logger = getLogger()

            const resource = await CloudFormation.getResourceFromTemplate({
                handlerName: params.handlerName,
                templatePath: params.samTemplate.fsPath,
            })
            const lambdaRuntime = CloudFormation.getRuntime(resource)
            let invokeResult: Result = 'Succeeded'
            try {
                if (!nodeJsRuntimes.has(lambdaRuntime)) {
                    invokeResult = 'Failed'
                    logger.error(
                        `Javascript local invoke on ${params.uri.fsPath} encountered` +
                            ` unsupported runtime ${lambdaRuntime}`
                    )

                    vscode.window.showErrorMessage(
                        localize(
                            'AWS.samcli.local.invoke.runtime.unsupported',
                            'Unsupported {0} runtime: {1}',
                            'javascript',
                            lambdaRuntime
                        )
                    )
                } else {
                    await invokeLambda({
                        runtime: lambdaRuntime,
                        ...params,
                    })
                }
            } catch (err) {
                invokeResult = 'Failed'
                throw err
            } finally {
                recordLambdaInvokeLocal({
                    result: invokeResult,
                    runtime: lambdaRuntime as Runtime,
                    debug: params.isDebug,
                })
            }
        })
    )
}

export async function findParentProjectFile(
    sourceCodeUri: vscode.Uri,
    searchPattern: string,
    findWorkspaceFiles: typeof vscode.workspace.findFiles = vscode.workspace.findFiles
): Promise<vscode.Uri | undefined> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(sourceCodeUri)
    if (!workspaceFolder) {
        return undefined
    }

    const workspaceProjectFiles: vscode.Uri[] = await findWorkspaceFiles(
        new vscode.RelativePattern(workspaceFolder, searchPattern)
    )

    // Use the project file "closest" in the parent chain to sourceCodeUri
    let parentProjectFiles = workspaceProjectFiles
        .filter(uri => {
            const dirname = dirnameWithTrailingSlash(uri.fsPath)

            return sourceCodeUri.fsPath.startsWith(dirname)
        })
        .sort((a, b) => {
            if (isInDirectory(path.parse(a.fsPath).dir, path.parse(b.fsPath).dir)) {
                return 1
            }

            return -1
        })

    return parentProjectFiles.length === 0 ? undefined : parentProjectFiles[0]
}
