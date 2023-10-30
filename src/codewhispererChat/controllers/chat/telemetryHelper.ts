/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { UserIntent } from '@amzn/codewhisperer-streaming'
import { CwsprChatUserIntent, telemetry } from '../../../shared/telemetry/telemetry'
import { ChatSessionStorage } from '../../storages/chatSession'
import { CopyCodeToClipboard, InsertCodeAtCursorPosition, PromptMessage, TriggerPayload } from './model'
import { TriggerEvent, TriggerEventsStorage } from '../../storages/triggerEvents'

export class CWCTelemetryHelper {
    private sessionStorage?: ChatSessionStorage
    private triggerEventsStorage?: TriggerEventsStorage

    static #instance: CWCTelemetryHelper

    public static get instance() {
        return (this.#instance ??= new this())
    }

    private getUserIntentForTelemetry(userIntent: UserIntent | undefined): CwsprChatUserIntent | undefined {
        switch (userIntent) {
            case UserIntent.EXPLAIN_CODE_SELECTION:
                return 'explainCodeSelection'
            case UserIntent.SUGGEST_ALTERNATE_IMPLEMENTATION:
                return 'suggestAlternateImplementation'
            case UserIntent.APPLY_COMMON_BEST_PRACTICES:
                return 'applyCommonBestPractices'
            case UserIntent.IMPROVE_CODE:
                return 'improveCode'
            default:
                return undefined
        }
    }

    public recordInteractWithMessage(message: InsertCodeAtCursorPosition | CopyCodeToClipboard | PromptMessage) {
        const conversationId = this.sessionStorage?.getSession(message.tabID).sessionIdentifier

        switch (message.command) {
            case 'insert_code_at_cursor_position':
                //TODO: message id and has reference
                message = message as InsertCodeAtCursorPosition
                telemetry.codewhispererchat_interactWithMessage.emit({
                    cwsprChatConversationId: conversationId ?? '',
                    cwsprChatMessageId: '',
                    cwsprChatInteractionType: 'insertAtCursor',
                    cwsprChatAcceptedCharactersLength: message.code.length,
                    cwsprChatInteractionTarget: message.insertionTargetType,
                    cwsprChatHasReference: undefined,
                })
                break
            case 'code_was_copied_to_clipboard':
                //TODO: message id and has reference
                message = message as CopyCodeToClipboard
                telemetry.codewhispererchat_interactWithMessage.emit({
                    cwsprChatConversationId: conversationId ?? '',
                    cwsprChatMessageId: '',
                    cwsprChatInteractionType: 'copySnippet',
                    cwsprChatAcceptedCharactersLength: message.code.length,
                    cwsprChatInteractionTarget: message.insertionTargetType,
                    cwsprChatHasReference: undefined,
                })
                break
            case 'follow-up-was-clicked':
                //TODO: message id
                message = message as PromptMessage
                telemetry.codewhispererchat_interactWithMessage.emit({
                    cwsprChatConversationId: conversationId ?? '',
                    cwsprChatMessageId: '',
                    cwsprChatInteractionType: 'clickFollowUp',
                })
        }
    }

    public recordStartConversation(triggerEvent: TriggerEvent, triggerPayload: TriggerPayload) {
        if (triggerEvent.tabID == undefined) {
            return
        }

        if (
            this.triggerEventsStorage &&
            this.triggerEventsStorage.getTriggerEventsByTabID(triggerEvent.tabID).length > 0
        ) {
            return
        }

        const conversationId = this.sessionStorage?.getSession(triggerEvent.tabID).sessionIdentifier
        const telemetryUserIntent = this.getUserIntentForTelemetry(triggerPayload.userIntent)

        telemetry.codewhispererchat_startConversation.emit({
            cwsprChatConversationId: conversationId ?? '',
            cwsprChatConversationType: 'Chat',
            cwsprChatUserIntent: telemetryUserIntent,
            cwsprChatHasCodeSnippet: triggerPayload.codeSelection != undefined,
            cwsprChatProgrammingLanguage: triggerPayload.fileLanguage,
        })
    }

    public setChatSesionStorage(sessionStorage: ChatSessionStorage) {
        this.sessionStorage = sessionStorage
    }

    public setTriggerEventsStorage(triggerEventsStorage: TriggerEventsStorage) {
        this.triggerEventsStorage = triggerEventsStorage
    }
}
