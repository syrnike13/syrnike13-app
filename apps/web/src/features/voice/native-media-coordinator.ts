export type NativePublisherIdleState = {
  status: 'idle'
}

export type NativePublisherStartingState = {
  status: 'starting'
  operationId: string
  channelId: string
  requestId: string
}

export type NativePublisherPublishedState = {
  status: 'published'
  operationId: string
  channelId: string
  participantIdentity: string
}

export type NativePublisherStoppingState = {
  status: 'stopping'
  operationId: string
  channelId: string
  participantIdentity?: string
}

export type NativePublisherFailedState = {
  status: 'failed'
  operationId: string
  channelId: string
  error: string
}

export type NativePublisherState =
  | NativePublisherIdleState
  | NativePublisherStartingState
  | NativePublisherPublishedState
  | NativePublisherStoppingState
  | NativePublisherFailedState

export type NativeScreenIdleState = NativePublisherIdleState & {
  visibleInRoom: false
}

export type NativeScreenStartingState = NativePublisherStartingState & {
  visibleInRoom: false
}

export type NativeScreenPublishedState = NativePublisherPublishedState & {
  visibleInRoom: true
  publicationSid: string
}

export type NativeScreenStoppingState = NativePublisherStoppingState & {
  visibleInRoom: false
  publicationSid?: string
}

export type NativeScreenFailedState = NativePublisherFailedState & {
  visibleInRoom: false
}

export type NativeScreenState =
  | NativeScreenIdleState
  | NativeScreenStartingState
  | NativeScreenPublishedState
  | NativeScreenStoppingState
  | NativeScreenFailedState

export type NativeMediaState = {
  microphone: NativePublisherState
  screen: NativeScreenState
}

export type NativeMediaAction =
  | {
      type: 'screen_start_requested'
      operationId: string
      channelId: string
      requestId: string
    }
  | {
      type: 'screen_publication_observed'
      operationId: string
      channelId: string
      participantIdentity: string
      publicationSid: string
    }
  | {
      type: 'screen_failed'
      operationId: string
      channelId: string
      error: string
    }
  | { type: 'screen_stopped' }
  | { type: 'reset' }

export function createInitialNativeMediaState(): NativeMediaState {
  return {
    microphone: { status: 'idle' },
    screen: {
      status: 'idle',
      visibleInRoom: false,
    },
  }
}

function isCurrentScreenAction(
  state: NativeMediaState,
  action: {
    operationId: string
    channelId: string
  },
) {
  const screen = state.screen
  return (
    screen.status !== 'idle' &&
    screen.operationId === action.operationId &&
    screen.channelId === action.channelId
  )
}

export function nativeMediaReducer(
  state: NativeMediaState,
  action: NativeMediaAction,
): NativeMediaState {
  switch (action.type) {
    case 'screen_start_requested':
      return {
        ...state,
        screen: {
          status: 'starting',
          operationId: action.operationId,
          channelId: action.channelId,
          requestId: action.requestId,
          visibleInRoom: false,
        },
      }

    case 'screen_publication_observed':
      if (!isCurrentScreenAction(state, action)) return state
      return {
        ...state,
        screen: {
          status: 'published',
          operationId: action.operationId,
          channelId: action.channelId,
          participantIdentity: action.participantIdentity,
          publicationSid: action.publicationSid,
          visibleInRoom: true,
        },
      }

    case 'screen_failed':
      if (!isCurrentScreenAction(state, action)) return state
      return {
        ...state,
        screen: {
          status: 'failed',
          operationId: action.operationId,
          channelId: action.channelId,
          error: action.error,
          visibleInRoom: false,
        },
      }

    case 'screen_stopped':
    case 'reset':
      return createInitialNativeMediaState()
  }
}

export function isNativeScreenPublished(state: NativeMediaState) {
  return state.screen.status === 'published' && state.screen.visibleInRoom
}

export function isNativeScreenStarting(state: NativeMediaState) {
  return state.screen.status === 'starting'
}
