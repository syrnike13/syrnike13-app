import type { Room } from 'livekit-client'

import {
  createInitialDirectorState,
  reduceDirector,
  type VoiceDirectorState,
  type VoiceJoinReason,
} from '#/features/voice/voice-intent-director'
import { createVoiceOperationId } from '#/features/voice/voice-operation'
import type {
  ActiveVoiceSessionSnapshot,
  LiveKitNativeCredentials,
} from '#/features/voice/voice-join'
import type { VoiceConnectionPhase } from '#/features/voice/voice-mic-status'
import { createVoiceRejoinController } from '#/features/voice/voice-rejoin'
import {
  runVoiceRecovery,
  type VoiceRecoveryRunnerDeps,
} from '#/features/voice/voice-recovery-runner'

export type VoiceExecutorSnapshot = {
  activeOperationId: string | null
  room: Room | null
  committedChannelId: string | null
  phase: VoiceDirectorState['phase']
  lastError: string | null
}

export type VoiceIntentExecutorJoinOptions = {
  operationId: string
  reason: VoiceJoinReason
}

export type VoiceIntentExecutorJoinResult =
  | boolean
  | {
      room: Room
    }

export type VoiceTerminalLeaveSession = {
  channelId: string
  room: Room | null
}

export type VoiceLocalDisconnectSession = {
  channelId: string | null
  room: Room | null
}

export type VoiceMoveSourceSession = ActiveVoiceSessionSnapshot & {
  operationId: string
}

export type VoiceExecutorRecoveryDeps = Omit<
  VoiceRecoveryRunnerDeps,
  | 'getDesiredChannelId'
  | 'getRoom'
  | 'requestRejoinOperation'
  | 'stopRemoteSupersededVoiceSession'
  | 'getPendingRejoinChannelId'
  | 'getJoinInFlight'
  | 'setJoinInFlight'
>

type VoiceJoinInFlight = {
  channelId: string
  promise: Promise<boolean>
}

export type VoiceExecutorDeps = {
  getToken: () => string | undefined
  getLocalUserId: () => string | undefined
  isJoinBlocked: () => boolean
  getActiveSession: () => ActiveVoiceSessionSnapshot | null
  performVoiceJoin: (
    channelId: string,
    options: VoiceIntentExecutorJoinOptions,
  ) => Promise<VoiceIntentExecutorJoinResult>
  requestVoiceLeave: () => void
  shouldKeepRejoining: (channelId: string) => boolean
  attachRoomHandlers: (room: Room) => void
  onRoomConnected: (room: Room, channelId: string) => void
  onAbort: () => void
  beginVisualTransition: (channelId: string) => void
  clearVisualPresence: (channelId: string) => void
  completeTerminalLeave: (
    session: VoiceTerminalLeaveSession,
  ) => Promise<void> | void
  disconnectLocalSession: (
    session: VoiceLocalDisconnectSession,
  ) => Promise<void> | void
  disconnectMoveSource: (
    session: VoiceMoveSourceSession,
  ) => Promise<void> | void
  onRoomChanged: (room: Room | null) => void
  setLiveKitCredentials: (credentials: LiveKitNativeCredentials) => void
  setConnectionPhase: (phase: VoiceConnectionPhase) => void
  recovery: VoiceExecutorRecoveryDeps
  createOperationId?: () => string
}

export interface VoiceIntentExecutor {
  getState(): VoiceDirectorState
  getSnapshot(): VoiceExecutorSnapshot
  getRoom(): Room | null
  subscribe(listener: (state: VoiceDirectorState) => void): () => void
  intent(channelId: string, reason: VoiceJoinReason): void
  requestRejoin(channelId: string): string
  clearIntent(): void
  observeCommit(operationId: string, channelId: string): void
  observeLeave(operationId: string | null): void
  observeDisconnected(
    operationId: string,
    expected: boolean,
    error?: string,
  ): void
  observeSupersede(reason: string, targetChannelId?: string): void
  reconcileWithServer(trigger: string): void
  onRoomDisconnected(expected: boolean, error?: string): void
  disconnectLocalSession(): Promise<void>
  reset(): void
  teardown(): Promise<void>
}

export function createVoiceIntentExecutor(
  deps: VoiceExecutorDeps,
): VoiceIntentExecutor {
  const createOperationId = deps.createOperationId ?? createVoiceOperationId
  const listeners = new Set<(state: VoiceDirectorState) => void>()
  let state = createInitialDirectorState()
  let room: Room | null = null
  let executing = false
  let startedOperationId: string | null = null
  let pendingMoveSource: VoiceMoveSourceSession | null = null
  let remoteSupersedeDisconnect: Promise<void> | null = null
  let recoveryJoinInFlight: VoiceJoinInFlight | null = null

  function getSnapshot(): VoiceExecutorSnapshot {
    return {
      activeOperationId: state.activeOperationId,
      room,
      committedChannelId: state.committed,
      phase: state.phase,
      lastError: state.lastError,
    }
  }

  function notify() {
    for (const listener of listeners) {
      listener(state)
    }
  }

  function dispatch(event: Parameters<typeof reduceDirector>[1]) {
    const next = reduceDirector(state, event, createOperationId)
    if (next === state) {
      return
    }
    state = next
    notify()
    void maybeExecute()
  }

  function isCurrent(operationId: string) {
    return (
      state.activeOperationId === operationId &&
      state.steps[0]?.operationId === operationId
    )
  }

  function canAcceptJoinResult(operationId: string, channelId: string) {
    if (isCurrent(operationId)) {
      return true
    }
    return (
      state.activeOperationId === null &&
      state.committed === channelId &&
      state.desired.kind === 'channel' &&
      state.desired.channelId === channelId
    )
  }

  function setRoom(nextRoom: Room | null) {
    if (room === nextRoom) {
      return
    }
    room = nextRoom
    deps.onRoomChanged(room)
  }

  function finalizeMoveSource(operationId: string) {
    const source = pendingMoveSource
    if (!source || source.operationId !== operationId) {
      return
    }
    pendingMoveSource = null
    void deps.disconnectMoveSource(source)
    if (room === source.room) {
      setRoom(null)
    }
  }

  function restoreMoveSource(channelId: string) {
    const source = pendingMoveSource
    if (!source || source.channelId !== channelId) {
      return false
    }

    const targetRoom = room
    pendingMoveSource = null
    setRoom(source.room)
    if (targetRoom && targetRoom !== source.room) {
      targetRoom.removeAllListeners()
      void targetRoom.disconnect().catch(() => {})
    }
    dispatch({
      type: 'restore_source',
      channelId,
      supersededOperationId: state.activeOperationId,
    })
    return true
  }

  async function maybeExecute() {
    if (executing) {
      return
    }

    const head = state.steps[0]
    if (!head || state.activeOperationId !== head.operationId) {
      return
    }
    if (startedOperationId === head.operationId) {
      return
    }

    startedOperationId = head.operationId
    executing = true
    try {
      if (head.kind === 'hard_leave') {
        await executeHardLeave(head.operationId, head.channelId)
      } else {
        await executeJoin(head.operationId, head.channelId, head.reason)
      }
    } finally {
      executing = false
      void maybeExecute()
    }
  }

  async function executeHardLeave(operationId: string, channelId: string) {
    if (!isCurrent(operationId)) {
      return
    }

    const terminalLeave = state.desired.kind === 'none' && state.steps.length === 1
    deps.requestVoiceLeave()
    deps.clearVisualPresence(channelId)
    if (terminalLeave) {
      const terminalRoom = room
      await deps.completeTerminalLeave({ channelId, room: terminalRoom })
      if (room === terminalRoom) {
        setRoom(null)
      }
    }

    if (!isCurrent(operationId)) {
      return
    }
    dispatch({ type: 'leave_observed', operationId })
  }

  async function executeJoin(
    operationId: string,
    channelId: string,
    reason: VoiceJoinReason,
  ) {
    if (!isCurrent(operationId)) {
      return
    }

    deps.beginVisualTransition(channelId)
    const moveSource =
      reason === 'rejoin' ? null : deps.getActiveSession()
    try {
      const result = await deps.performVoiceJoin(channelId, {
        operationId,
        reason,
      })
      if (!canAcceptJoinResult(operationId, channelId)) {
        return
      }
      if (result === false) {
        dispatch({
          type: 'step_failed',
          operationId,
          error: 'Voice join was aborted',
        })
        return
      }
      if (typeof result === 'object') {
        if (
          moveSource &&
          moveSource.room !== result.room &&
          moveSource.channelId !== channelId
        ) {
          pendingMoveSource = {
            ...moveSource,
            operationId,
          }
        }
        setRoom(result.room)
        if (state.committed === channelId) {
          finalizeMoveSource(operationId)
        }
      }
      dispatch({ type: 'step_awaiting_commit', operationId })
    } catch (error) {
      if (!isCurrent(operationId)) {
        return
      }
      dispatch({
        type: 'step_failed',
        operationId,
        error: error instanceof Error ? error.message : 'Voice join failed',
      })
    }
  }

  function disconnectRoom() {
    const currentRoom = room
    setRoom(null)
    if (!currentRoom) {
      return Promise.resolve()
    }
    currentRoom.removeAllListeners()
    return currentRoom.disconnect().catch(() => {})
  }

  function requestRejoin(channelId: string) {
    if (
      state.desired.kind === 'channel' &&
      state.desired.channelId === channelId &&
      state.activeOperationId !== null
    ) {
      return state.activeOperationId
    }
    dispatch({ type: 'force_rejoin', channelId })
    const operationId = state.activeOperationId
    if (!operationId) {
      throw new Error('Voice rejoin did not create an operation')
    }
    return operationId
  }

  const voiceRejoin = createVoiceRejoinController({
    attemptRejoin: async (channelId) => {
      requestRejoin(channelId)
      return true
    },
    onGiveUp: deps.onAbort,
    isGatewayConnected: () => deps.recovery.getGatewayConnected(),
    shouldKeepTrying: (channelId) =>
      Boolean(deps.getToken()) &&
      !deps.isJoinBlocked() &&
      deps.shouldKeepRejoining(channelId),
  })

  async function disconnectLocalSession() {
    const currentRoom = room
    const currentChannelId =
      state.committed ??
      (state.desired.kind === 'channel' ? state.desired.channelId : null)

    startedOperationId = null
    pendingMoveSource = null
    dispatch({ type: 'reset' })
    await deps.disconnectLocalSession({
      channelId: currentChannelId,
      room: currentRoom,
    })
    if (room === currentRoom) {
      setRoom(null)
    }
  }

  function observeSupersede(reason: string, targetChannelId?: string) {
    if (remoteSupersedeDisconnect) return
    if (!room && !state.committed && state.desired.kind !== 'channel') return

    console.warn('[voice-session] local voice session superseded', {
      reason,
      currentChannelId: state.committed,
      targetChannelId,
    })

    const promise = disconnectLocalSession()
    remoteSupersedeDisconnect = promise
    void promise.finally(() => {
      if (remoteSupersedeDisconnect === promise) {
        remoteSupersedeDisconnect = null
      }
    })
  }

  return {
    getState: () => state,
    getSnapshot,
    getRoom: () => room,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    intent(channelId, reason) {
      voiceRejoin.cancel()
      if (restoreMoveSource(channelId)) {
        return
      }
      dispatch({ type: 'intent', channelId, reason })
    },
    requestRejoin,
    clearIntent() {
      voiceRejoin.cancel()
      dispatch({ type: 'clear_intent' })
    },
    observeCommit(operationId, channelId) {
      voiceRejoin.cancel()
      dispatch({ type: 'commit', operationId, channelId })
      finalizeMoveSource(operationId)
    },
    observeLeave(operationId) {
      voiceRejoin.cancel()
      dispatch({ type: 'leave_observed', operationId })
    },
    observeDisconnected(operationId, expected, error) {
      dispatch({ type: 'disconnected', operationId, expected, error })
    },
    observeSupersede,
    reconcileWithServer(trigger) {
      if (trigger === 'gateway_connected') {
        voiceRejoin.onGatewayConnected()
      }
      runVoiceRecovery(trigger, {
        ...deps.recovery,
        getDesiredChannelId: () =>
          state.desired.kind === 'channel' ? state.desired.channelId : null,
        getRoom: () => room,
        getPendingRejoinChannelId: () => voiceRejoin.getPendingChannelId(),
        getJoinInFlight: () => recoveryJoinInFlight,
        setJoinInFlight: (join) => {
          recoveryJoinInFlight = join
        },
        requestRejoinOperation: requestRejoin,
        stopRemoteSupersededVoiceSession: observeSupersede,
      })
    },
    onRoomDisconnected(expected, error) {
      const operationId = state.activeOperationId
      if (!operationId && state.committed === null) {
        return
      }
      const reconnectChannelId =
        state.committed ??
        (state.desired.kind === 'channel' ? state.desired.channelId : null)
      if (!expected) {
        setRoom(null)
        if (reconnectChannelId) {
          voiceRejoin.onUnexpectedDisconnect(reconnectChannelId)
        }
      }
      dispatch({ type: 'disconnected', operationId, expected, error })
    },
    disconnectLocalSession,
    reset() {
      voiceRejoin.cancel()
      recoveryJoinInFlight = null
      startedOperationId = null
      state = createInitialDirectorState()
      notify()
    },
    async teardown() {
      this.reset()
      await disconnectRoom()
    },
  }
}
