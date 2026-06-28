import { createVoiceOperationId } from './voice-operation'
import {
  createInitialVoiceSessionState,
  reduceVoiceSession,
  type VoiceJoinReason,
  type VoiceSessionState,
} from './voice-session-machine'

type VoiceSessionListener = (state: VoiceSessionState) => void

export type VoiceSessionControllerOptions = {
  createOperationId?: () => string
}

export type VoiceJoinRequestOptions = {
  reason: VoiceJoinReason
}

export function createVoiceSessionController(
  options: VoiceSessionControllerOptions = {},
) {
  const createOperation = options.createOperationId ?? createVoiceOperationId
  const listeners = new Set<VoiceSessionListener>()
  let state = createInitialVoiceSessionState()

  const publish = (next: VoiceSessionState) => {
    if (next === state) return
    state = next
    for (const listener of listeners) {
      listener(state)
    }
  }

  const dispatch = (
    event: Parameters<typeof reduceVoiceSession>[1],
  ) => {
    publish(reduceVoiceSession(state, event))
  }

  return {
    getState: () => state,

    subscribe(listener: VoiceSessionListener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    requestJoin(channelId: string, joinOptions: VoiceJoinRequestOptions) {
      const operationId = createOperation()
      dispatch({
        type: 'join_requested',
        channelId,
        operationId,
        reason: joinOptions.reason,
      })
      return operationId
    },

    requestLeave() {
      const operationId = createOperation()
      dispatch({ type: 'leave_requested', operationId })
      return operationId
    },

    restorePreviousSession(channelId: string) {
      const operationId = createOperation()
      dispatch({
        type: 'previous_session_restored',
        channelId,
        operationId,
      })
      return operationId
    },

    handleServerPrepareSucceeded(operationId: string) {
      dispatch({ type: 'server_prepare_succeeded', operationId })
    },

    handleRoomConnected(operationId: string) {
      dispatch({ type: 'room_connected', operationId })
    },

    handleServerCommitObserved(operationId: string, channelId: string) {
      dispatch({
        type: 'server_commit_observed',
        operationId,
        channelId,
      })
    },

    handleNativePublishSucceeded(operationId: string) {
      dispatch({ type: 'native_publish_succeeded', operationId })
    },

    handleRoomConnectFailed(operationId: string, error: string) {
      dispatch({ type: 'room_connect_failed', operationId, error })
    },

    handleRoomDisconnected(options: {
      operationId: string
      expected: boolean
      error?: string
    }) {
      dispatch({ type: 'room_disconnected', ...options })
    },
  }
}

export type VoiceSessionController = ReturnType<
  typeof createVoiceSessionController
>
