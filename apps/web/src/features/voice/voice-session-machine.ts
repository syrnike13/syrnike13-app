export type VoiceJoinReason = 'manual_join' | 'switch' | 'dm_answer' | 'rejoin'

export type DesiredVoiceSession =
  | { kind: 'none'; operationId: string | null }
  | {
      kind: 'channel'
      channelId: string
      operationId: string
      reason: VoiceJoinReason
    }

export type VoiceRuntimePhase =
  | 'idle'
  | 'preparing'
  | 'connecting_rtc'
  | 'waiting_server_commit'
  | 'publishing_native'
  | 'connected'
  | 'reconnecting'
  | 'failed_retrying'
  | 'leaving'

export type VoiceSessionState = {
  desired: DesiredVoiceSession
  phase: VoiceRuntimePhase
  connectedChannelId: string | null
  activeOperationId: string | null
  previousChannelId: string | null
  lastError: string | null
}

export type VoiceSessionEvent =
  | {
      type: 'join_requested'
      channelId: string
      operationId: string
      reason: VoiceJoinReason
    }
  | { type: 'leave_requested'; operationId: string }
  | { type: 'server_prepare_succeeded'; operationId: string }
  | { type: 'room_connected'; operationId: string }
  | { type: 'server_commit_observed'; operationId: string; channelId: string }
  | { type: 'native_publish_succeeded'; operationId: string }
  | { type: 'room_connect_failed'; operationId: string; error: string }
  | {
      type: 'room_disconnected'
      operationId: string
      expected: boolean
      error?: string
    }

export function createInitialVoiceSessionState(): VoiceSessionState {
  return {
    desired: { kind: 'none', operationId: null },
    phase: 'idle',
    connectedChannelId: null,
    activeOperationId: null,
    previousChannelId: null,
    lastError: null,
  }
}

function isCurrentOperation(state: VoiceSessionState, operationId: string) {
  return state.activeOperationId === operationId
}

function shouldClearDesiredAfterConnectFailure(state: VoiceSessionState) {
  return (
    state.desired.kind === 'channel' &&
    state.previousChannelId === null &&
    (state.desired.reason === 'manual_join' ||
      state.desired.reason === 'dm_answer')
  )
}

export function reduceVoiceSession(
  state: VoiceSessionState,
  event: VoiceSessionEvent,
): VoiceSessionState {
  switch (event.type) {
    case 'join_requested':
      return {
        ...state,
        desired: {
          kind: 'channel',
          channelId: event.channelId,
          operationId: event.operationId,
          reason: event.reason,
        },
        phase: 'preparing',
        activeOperationId: event.operationId,
        previousChannelId: state.connectedChannelId,
        lastError: null,
      }

    case 'leave_requested':
      return {
        ...state,
        desired: { kind: 'none', operationId: event.operationId },
        phase: 'leaving',
        connectedChannelId: null,
        activeOperationId: event.operationId,
        previousChannelId: state.connectedChannelId,
        lastError: null,
      }

    case 'server_prepare_succeeded':
      if (!isCurrentOperation(state, event.operationId)) return state
      return { ...state, phase: 'connecting_rtc', lastError: null }

    case 'room_connected':
      if (!isCurrentOperation(state, event.operationId)) return state
      if (state.phase === 'connected') return state
      return { ...state, phase: 'waiting_server_commit', lastError: null }

    case 'server_commit_observed':
      if (!isCurrentOperation(state, event.operationId)) return state
      return {
        ...state,
        phase: 'connected',
        connectedChannelId: event.channelId,
        previousChannelId: null,
        lastError: null,
      }

    case 'native_publish_succeeded':
      if (!isCurrentOperation(state, event.operationId)) return state
      return state.phase === 'connected'
        ? state
        : { ...state, phase: 'connected', lastError: null }

    case 'room_connect_failed':
      if (!isCurrentOperation(state, event.operationId)) return state
      if (shouldClearDesiredAfterConnectFailure(state)) {
        return {
          ...state,
          desired: { kind: 'none', operationId: null },
          phase: 'idle',
          connectedChannelId: null,
          activeOperationId: null,
          previousChannelId: null,
          lastError: event.error,
        }
      }
      return { ...state, phase: 'failed_retrying', lastError: event.error }

    case 'room_disconnected':
      if (!isCurrentOperation(state, event.operationId)) return state
      if (event.expected) {
        return {
          ...state,
          desired: { kind: 'none', operationId: null },
          phase: 'idle',
          connectedChannelId: null,
          activeOperationId: null,
          previousChannelId: null,
          lastError: null,
        }
      }
      return {
        ...state,
        phase: 'reconnecting',
        connectedChannelId: null,
        lastError: event.error ?? 'Voice connection lost',
      }
  }
}
