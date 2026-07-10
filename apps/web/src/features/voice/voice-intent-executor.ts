import type { Room } from 'livekit-client'

import {
  createInitialDirectorState,
  reduceDirector,
  type VoiceDirectorState,
  type VoiceJoinReason,
} from '#/features/voice/voice-intent-director'
import { createVoiceOperationId } from '#/features/voice/voice-operation'
import type {
  VoiceConnectionPhase,
  VoiceStatus,
} from '#/features/voice/voice-mic-status'
import { createVoiceRejoinController } from '#/features/voice/voice-rejoin'
import {
  runVoiceRecovery,
  type VoiceRecoveryRunnerDeps,
} from '#/features/voice/voice-recovery-runner'
import {
  createVoiceNativeMediaOwner,
  type VoiceNativeMediaOwner,
} from '#/features/voice/voice-native-media-owner'

export type VoiceExecutorSnapshot = {
  activeOperationId: string | null
  room: Room | null
  channelId: string | null
  status: VoiceStatus
  localVoiceReady: boolean
  committedChannelId: string | null
  phase: VoiceDirectorState['phase']
  lastError: string | null
}

export type VoiceExecutorSession = Readonly<{
  operationId: string | null
  room: Room | null
  channelId: string | null
  status: VoiceStatus
  localVoiceReady: boolean
}>

export type VoiceIntentExecutorJoinOptions = {
  operationId: string
  reason: VoiceJoinReason
  expectedCurrentOperationId?: string
  reuseExistingRoom: boolean
  onGatewayDispatched: () => void
  onGatewayAccepted: () => void
  onGatewayRejected: (authoritativeOperationId: string | null) => void
  signal: AbortSignal
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

export type VoiceMoveSourceSession = {
  operationId: string
  room: Room
  channelId: string
  localVoiceReady: boolean
}

type PendingMoveSource = {
  source: VoiceExecutorSession & { operationId: string; room: Room; channelId: string }
  targetOperationId: string
}

export type VoiceRoomDisconnectDisposition =
  | 'ignored'
  | 'retained_source_lost'
  | 'candidate_lost'
  | 'committed_session_lost'

export type VoiceExecutorRecoveryDeps = Omit<
  VoiceRecoveryRunnerDeps,
  | 'getDesiredChannelId'
  | 'getActiveChannelId'
  | 'getStatus'
  | 'getRoom'
  | 'isCurrentVoiceSession'
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

type PublisherRepairState = {
  room: Room
  channelId: string
  inFlight: boolean
  failureCount: number
  retryAt: number
}

type ActiveJoinAttempt = {
  operationId: string
  abortController: AbortController
}

const PUBLISHER_REPAIR_BACKOFF_MS = [1_000, 5_000, 15_000, 30_000] as const

export type VoiceExecutorDeps = {
  getToken: () => string | undefined
  isJoinBlocked: () => boolean
  performVoiceJoin: (
    channelId: string,
    options: VoiceIntentExecutorJoinOptions,
  ) => Promise<VoiceIntentExecutorJoinResult>
  requestVoiceLeave: () => void
  shouldKeepRejoining: (channelId: string) => boolean
  startLocalVoiceSetup: (room: Room, channelId: string) => void
  onAbort: () => void
  prepareVisualTransition: (channelId: string) => void
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
  onSessionChanged: (session: VoiceExecutorSession) => void
  setConnectionPhase: (phase: VoiceConnectionPhase) => void
  recovery: VoiceExecutorRecoveryDeps
  createOperationId?: () => string
}

export type VoiceIntentExecutorOptions = {
  getDeps: () => VoiceExecutorDeps
  now?: () => number
  commitTimeoutMs?: number
}

export interface VoiceIntentExecutor {
  nativeMedia: VoiceNativeMediaOwner
  getState(): VoiceDirectorState
  getSnapshot(): VoiceExecutorSnapshot
  getRoom(): Room | null
  ownsRoom(room: Room): boolean
  subscribe(listener: (state: VoiceDirectorState) => void): () => void
  intent(channelId: string, reason: VoiceJoinReason): void
  requestRejoin(channelId: string): string
  clearIntent(): void
  observeCommit(operationId: string, channelId: string): void
  observeLeave(operationId: string): void
  observeDisconnected(
    operationId: string,
    expected: boolean,
    error?: string,
  ): void
  observeSupersede(reason: string, targetChannelId?: string): void
  reconcileWithServer(trigger: string, sourceRoom?: Room): void
  onRoomDisconnected(
    room: Room,
    expected: boolean,
    error?: string,
  ): VoiceRoomDisconnectDisposition
  observeLocalVoiceReady(
    room: Room,
    channelId: string,
    ready: boolean,
  ): void
  disconnectLocalSession(): Promise<void>
  reset(): void
  teardown(): Promise<void>
}

export function createVoiceIntentExecutor({
  getDeps,
  now = Date.now,
  commitTimeoutMs = 15_000,
}: VoiceIntentExecutorOptions): VoiceIntentExecutor {
  const createOperationId =
    getDeps().createOperationId ?? createVoiceOperationId
  const listeners = new Set<(state: VoiceDirectorState) => void>()
  let state = createInitialDirectorState()
  let session: VoiceExecutorSession = {
    operationId: null,
    room: null,
    channelId: null,
    status: 'idle',
    localVoiceReady: false,
  }
  let executing = false
  let startedOperationId: string | null = null
  let pendingMoveSource: PendingMoveSource | null = null
  let localSetupOperationId: string | null = null
  let remoteSupersedeDisconnect: Promise<void> | null = null
  let recoveryJoinInFlight: VoiceJoinInFlight | null = null
  let publisherRepairState: PublisherRepairState | null = null
  let activeJoinAttempt: ActiveJoinAttempt | null = null
  const commitTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const nativeMedia = createVoiceNativeMediaOwner()

  function syncNativeMediaContext() {
    nativeMedia.setVoiceContext({
      operationId: state.activeOperationId ?? state.committedOperationId,
      channelId:
        session.channelId ??
        state.committed ??
        (state.desired.kind === 'channel' ? state.desired.channelId : null),
    })
  }

  function getSnapshot(): VoiceExecutorSnapshot {
    return {
      activeOperationId: state.activeOperationId,
      room: session.room,
      channelId: session.channelId,
      status: session.status,
      localVoiceReady: session.localVoiceReady,
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
    if (event.type === 'reset') {
      clearAllCommitTimers()
    } else if (
      event.type === 'step_failed' ||
      event.type === 'disconnected'
    ) {
      if (event.operationId) {
        clearCommitTimer(event.operationId)
      }
    }
    const previousOperationId = state.activeOperationId
    const next = reduceDirector(state, event, createOperationId)
    if (next === state) {
      return
    }
    state = next
    if (
      previousOperationId &&
      previousOperationId !== state.activeOperationId &&
      (
        event.type === 'reset' ||
        event.type === 'force_rejoin' ||
        event.type === 'gateway_rejected' ||
        state.operationJournal.some(
          (record) =>
            record.operationId === previousOperationId &&
            (record.lifecycle === 'superseded' ||
              record.lifecycle === 'failed'),
        )
      ) &&
      activeJoinAttempt?.operationId === previousOperationId
    ) {
      activeJoinAttempt.abortController.abort()
    }
    if (
      previousOperationId &&
      previousOperationId !== state.activeOperationId &&
      state.committedOperationId !== previousOperationId
    ) {
      clearCommitTimer(previousOperationId)
    }
    notify()
    syncNativeMediaContext()
    void maybeExecute()
  }

  function clearCommitTimer(operationId: string) {
    const timer = commitTimers.get(operationId)
    if (timer !== undefined) {
      clearTimeout(timer)
      commitTimers.delete(operationId)
    }
  }

  function clearAllCommitTimers() {
    for (const timer of commitTimers.values()) {
      clearTimeout(timer)
    }
    commitTimers.clear()
  }

  function operationWasDispatched(operationId: string) {
    return Boolean(
      state.operationJournal.find(
        (record) => record.operationId === operationId,
      )?.gatewayDispatched,
    )
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

  function setSession(next: VoiceExecutorSession) {
    if (
      session.operationId === next.operationId &&
      session.room === next.room &&
      session.channelId === next.channelId &&
      session.status === next.status &&
      session.localVoiceReady === next.localVoiceReady
    ) {
      return
    }
    session = next
    getDeps().onSessionChanged(session)
    syncNativeMediaContext()
  }

  function setIdleSession() {
    localSetupOperationId = null
    setSession({
      operationId: null,
      room: null,
      channelId: null,
      status: 'idle',
      localVoiceReady: false,
    })
  }

  function finalizeMoveSource(operationId: string) {
    const pending = pendingMoveSource
    if (!pending || pending.targetOperationId !== operationId) {
      return
    }
    pendingMoveSource = null
    const { source } = pending
    void Promise.resolve(getDeps().disconnectMoveSource({
      operationId,
      room: source.room,
      channelId: source.channelId,
      localVoiceReady: source.localVoiceReady,
    })).catch(
      (error: unknown) => {
        // disconnect не должен рвать исполнение очереди; логируем и идём дальше.
        console.warn('[voice-intent] failed to disconnect move source', error)
      },
    )
  }

  function restoreMoveSource(channelId: string) {
    const pending = pendingMoveSource
    if (
      !pending ||
      pending.source.channelId !== channelId ||
      state.committed !== channelId
    ) {
      return false
    }

    const gatewayDispatched = operationWasDispatched(
      pending.targetOperationId,
    )

    const targetRoom = session.room
    const { source } = pending
    setSession(source)
    getDeps().setConnectionPhase(
      source.localVoiceReady ? 'connected' : 'connecting_microphone',
    )
    localSetupOperationId = source.operationId
    if (!source.localVoiceReady) {
      getDeps().startLocalVoiceSetup(source.room, source.channelId)
    }
    if (targetRoom && targetRoom !== source.room) {
      targetRoom.removeAllListeners()
      void targetRoom.disconnect().catch(() => {})
    }

    if (gatewayDispatched) {
      pendingMoveSource = null
      dispatch({
        type: 'restore_source_after_dispatch',
        channelId,
        retainedOperationId: source.operationId,
        expectedCurrentOperationId: pending.targetOperationId,
        reason: 'switch',
      })
      return true
    }

    pendingMoveSource = null
    dispatch({
      type: 'restore_source',
      channelId,
      supersededOperationId: state.activeOperationId,
    })
    return true
  }

  function completeCommittedRoom(operationId: string, channelId: string) {
    if (
      session.operationId !== operationId ||
      session.channelId !== channelId ||
      !session.room ||
      state.committedOperationId !== operationId ||
      state.committed !== channelId
    ) {
      return
    }

    const room = session.room
    setSession({
      ...session,
      status: 'connected',
    })
    if (localSetupOperationId !== operationId) {
      localSetupOperationId = operationId
      getDeps().startLocalVoiceSetup(room, channelId)
    }
    finalizeMoveSource(operationId)
  }

  function armCommitTimeout(operationId: string, channelId: string) {
    clearCommitTimer(operationId)
    const timer = setTimeout(() => {
      commitTimers.delete(operationId)
      if (!isCurrent(operationId)) return

      const retained =
        pendingMoveSource?.targetOperationId === operationId
          ? pendingMoveSource
          : null
      const candidateRoom =
        session.operationId === operationId ? session.room : null
      if (retained) {
        pendingMoveSource = null
        const { source } = retained
        setSession(source)
        getDeps().setConnectionPhase(
          source.localVoiceReady ? 'connected' : 'connecting_microphone',
        )
        localSetupOperationId = source.operationId
        if (!source.localVoiceReady) {
          getDeps().startLocalVoiceSetup(source.room, source.channelId)
        }
        if (candidateRoom && candidateRoom !== source.room) {
          void disconnectRoom(candidateRoom)
        }
      } else if (candidateRoom && state.committedOperationId !== operationId) {
        void disconnectRoom(candidateRoom)
        setIdleSession()
      }

      dispatch({
        type: 'step_failed',
        operationId,
        error: `Voice commit timed out for ${channelId}`,
      })
    }, commitTimeoutMs)
    commitTimers.set(operationId, timer)
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
    const deps = getDeps()
    deps.requestVoiceLeave()
    deps.clearVisualPresence(channelId)
    if (terminalLeave) {
      const terminalRoom = session.room
      await deps.completeTerminalLeave({ channelId, room: terminalRoom })
      if (session.room === terminalRoom) {
        setIdleSession()
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

    const deps = getDeps()
    const previousSession = session
    const expectedCurrentOperationId = headExpectedCurrentOperationId(
      state,
      operationId,
    )
    const retainFinalized = headRetainsFinalized(state, operationId)
    const reuseExistingRoom = Boolean(
      retainFinalized &&
      expectedCurrentOperationId &&
      previousSession.room &&
      previousSession.channelId === channelId,
    )
    if (reuseExistingRoom) {
      pendingMoveSource = null
    } else if (
      !pendingMoveSource &&
      previousSession.room &&
      previousSession.channelId &&
      previousSession.operationId &&
      previousSession.status === 'connected'
    ) {
      pendingMoveSource = {
        source: {
          ...previousSession,
          operationId: previousSession.operationId,
          room: previousSession.room,
          channelId: previousSession.channelId,
        },
        targetOperationId: operationId,
      }
    } else if (pendingMoveSource) {
      pendingMoveSource.targetOperationId = operationId
    } else if (previousSession.room) {
      previousSession.room.removeAllListeners()
      void previousSession.room.disconnect().catch(() => {})
    }

    localSetupOperationId = null
    deps.prepareVisualTransition(channelId)
    setSession({
      operationId,
      room: reuseExistingRoom ? previousSession.room : null,
      channelId,
      status: reuseExistingRoom ? previousSession.status : 'connecting',
      localVoiceReady: reuseExistingRoom
        ? previousSession.localVoiceReady
        : false,
    })
    const abortController = new AbortController()
    activeJoinAttempt = { operationId, abortController }
    try {
      const result = await deps.performVoiceJoin(channelId, {
        operationId,
        reason,
        ...(expectedCurrentOperationId
          ? { expectedCurrentOperationId }
          : {}),
        reuseExistingRoom,
        onGatewayDispatched: () => {
          dispatch({ type: 'gateway_dispatched', operationId })
        },
        onGatewayAccepted: () => {
          dispatch({ type: 'gateway_accepted', operationId })
        },
        onGatewayRejected: (authoritativeOperationId) => {
          dispatch({
            type: 'gateway_rejected',
            operationId,
            authoritativeOperationId,
          })
        },
        signal: abortController.signal,
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
        setSession({
          operationId,
          room: result.room,
          channelId,
          status: 'connecting',
          localVoiceReady: false,
        })
      }
      dispatch({ type: 'step_awaiting_commit', operationId })
      completeCommittedRoom(operationId, channelId)
      if (isCurrent(operationId)) {
        armCommitTimeout(operationId, channelId)
      }
    } catch (error) {
      if (!isCurrent(operationId)) {
        return
      }
      dispatch({
        type: 'step_failed',
        operationId,
        error: error instanceof Error ? error.message : 'Voice join failed',
      })
    } finally {
      if (activeJoinAttempt?.operationId === operationId) {
        activeJoinAttempt = null
      }
    }
  }

  function disconnectRoom(room: Room | null) {
    if (!room) {
      return Promise.resolve()
    }
    room.removeAllListeners()
    return room.disconnect().catch(() => {})
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
    onGiveUp: () => {
      getDeps().onAbort()
      resetExecutor()
    },
    isGatewayConnected: () => getDeps().recovery.getGatewayConnected(),
    shouldKeepTrying: (channelId) =>
      Boolean(getDeps().getToken()) &&
      !getDeps().isJoinBlocked() &&
      getDeps().shouldKeepRejoining(channelId),
  })

  async function disconnectLocalSession() {
    const currentRoom = session.room
    const currentChannelId =
      state.committed ??
      session.channelId ??
      (state.desired.kind === 'channel' ? state.desired.channelId : null)
    const retainedSource = pendingMoveSource

    startedOperationId = null
    pendingMoveSource = null
    dispatch({ type: 'reset' })
    setIdleSession()

    const disconnects: Promise<unknown>[] = [
      Promise.resolve(getDeps().disconnectLocalSession({
        channelId: currentChannelId,
        room: currentRoom,
      })),
    ]
    if (retainedSource && retainedSource.source.room !== currentRoom) {
      disconnects.push(
        Promise.resolve(getDeps().disconnectMoveSource({
          operationId: retainedSource.targetOperationId,
          room: retainedSource.source.room,
          channelId: retainedSource.source.channelId,
          localVoiceReady: retainedSource.source.localVoiceReady,
        })),
      )
    }
    await Promise.all(disconnects)
  }

  function observeSupersede(reason: string, targetChannelId?: string) {
    if (remoteSupersedeDisconnect) return
    if (!session.room && !state.committed && state.desired.kind !== 'channel') return

    console.warn('[voice-session] local voice session superseded', {
      reason,
      currentChannelId: state.committed,
      targetChannelId,
    })

    const promise = disconnectLocalSession().catch((error) => {
      // disconnect при supersede не должен всплывать unhandled rejection.
      console.warn('[voice-intent] failed to disconnect superseded session', error)
    })
    remoteSupersedeDisconnect = promise
    void promise.finally(() => {
      if (remoteSupersedeDisconnect === promise) {
        remoteSupersedeDisconnect = null
      }
    })
  }

  function resetExecutor() {
    activeJoinAttempt?.abortController.abort()
    activeJoinAttempt = null
    voiceRejoin.cancel()
    recoveryJoinInFlight = null
    publisherRepairState = null
    clearAllCommitTimers()
    startedOperationId = null
    pendingMoveSource = null
    state = createInitialDirectorState()
    setIdleSession()
    notify()
  }

  return {
    nativeMedia,
    getState: () => state,
    getSnapshot,
    getRoom: () => session.room,
    ownsRoom: (room) =>
      session.room === room || pendingMoveSource?.source.room === room,
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
      if (
        state.committed === channelId &&
        state.desired.kind === 'channel' &&
        state.desired.channelId !== channelId
      ) {
        requestRejoin(channelId)
        return
      }
      dispatch({ type: 'intent', channelId, reason })
    },
    requestRejoin,
    clearIntent() {
      voiceRejoin.cancel()
      if (
        pendingMoveSource &&
        state.committed === pendingMoveSource.source.channelId
      ) {
        restoreMoveSource(pendingMoveSource.source.channelId)
      } else if (pendingMoveSource) {
        finalizeMoveSource(pendingMoveSource.targetOperationId)
      }
      dispatch({ type: 'clear_intent' })
      if (state.committed === null && state.steps.length === 0) {
        const transientRoom = session.room
        setIdleSession()
        void disconnectRoom(transientRoom)
      }
    },
    observeCommit(operationId, channelId) {
      voiceRejoin.cancel()
      clearCommitTimer(operationId)
      dispatch({ type: 'commit', operationId, channelId })
      completeCommittedRoom(operationId, channelId)
    },
    observeLeave(operationId) {
      voiceRejoin.cancel()
      if (state.committedOperationId !== operationId) {
        dispatch({ type: 'leave_observed', operationId })
        return
      }
      const lostCurrentRoom =
        session.operationId === operationId ? session.room : null
      const lostRetainedRoom =
        pendingMoveSource?.source.operationId === operationId
          ? pendingMoveSource.source.room
          : null
      if (lostRetainedRoom) {
        pendingMoveSource = null
      }
      if (lostCurrentRoom) {
        setSession({
          operationId,
          room: null,
          channelId: session.channelId,
          status: session.channelId ? 'connecting' : 'idle',
          localVoiceReady: false,
        })
      }
      dispatch({ type: 'leave_observed', operationId })
      if (lostCurrentRoom) {
        void disconnectRoom(lostCurrentRoom)
      }
      if (lostRetainedRoom && lostRetainedRoom !== lostCurrentRoom) {
        void disconnectRoom(lostRetainedRoom)
      }
    },
    observeDisconnected(operationId, expected, error) {
      clearCommitTimer(operationId)
      dispatch({ type: 'disconnected', operationId, expected, error })
    },
    observeSupersede,
    reconcileWithServer(trigger, sourceRoom) {
      if (trigger === 'gateway_connected') {
        voiceRejoin.onGatewayConnected()
      }
      if (
        (sourceRoom && sourceRoom !== session.room) ||
        !session.room ||
        !session.channelId ||
        session.status !== 'connected' ||
        state.committed !== session.channelId
      ) {
        return
      }
      const recovery = getDeps().recovery
      const repairOwner = {
        room: session.room,
        channelId: session.channelId,
      }
      runVoiceRecovery(trigger, {
        ...recovery,
        // A committed Room becomes receive-ready before local microphone setup
        // finishes. Treat its publisher as provisionally healthy until that
        // setup reports completion, otherwise participant/health events can
        // race the initial A→B→A reconnect with a second reconnect command.
        isPublisherHealthy: (room) =>
          !session.localVoiceReady || recovery.isPublisherHealthy(room),
        tryStartPublisherRepair: () => {
          let repairState = publisherRepairState
          if (
            repairState?.room !== repairOwner.room ||
            repairState.channelId !== repairOwner.channelId
          ) {
            repairState = {
              ...repairOwner,
              inFlight: false,
              failureCount: 0,
              retryAt: 0,
            }
            publisherRepairState = repairState
          }
          if (repairState.inFlight || now() < repairState.retryAt) {
            return false
          }
          repairState.inFlight = true
          return true
        },
        endPublisherRepair: (succeeded) => {
          const repairState = publisherRepairState
          if (
            repairState?.room !== repairOwner.room ||
            repairState.channelId !== repairOwner.channelId
          ) {
            return
          }
          repairState.inFlight = false
          if (succeeded) {
            repairState.failureCount = 0
            repairState.retryAt = 0
            return
          }
          repairState.failureCount += 1
          const delay = PUBLISHER_REPAIR_BACKOFF_MS[
            Math.min(
              repairState.failureCount - 1,
              PUBLISHER_REPAIR_BACKOFF_MS.length - 1,
            )
          ]
          repairState.retryAt = now() + delay
        },
        getActiveChannelId: () => session.channelId,
        getDesiredChannelId: () =>
          state.desired.kind === 'channel' ? state.desired.channelId : null,
        getStatus: () => session.status,
        getRoom: () => session.room,
        isCurrentVoiceSession: (room, channelId) =>
          session.room === room &&
          session.channelId === channelId &&
          session.status === 'connected',
        getPendingRejoinChannelId: () => voiceRejoin.getPendingChannelId(),
        getJoinInFlight: () => recoveryJoinInFlight,
        setJoinInFlight: (join) => {
          recoveryJoinInFlight = join
        },
        requestRejoinOperation: requestRejoin,
        stopRemoteSupersededVoiceSession: observeSupersede,
      })
    },
    onRoomDisconnected(room, expected, error) {
      if (pendingMoveSource?.source.room === room) {
        pendingMoveSource = null
        return 'retained_source_lost'
      }
      if (session.room !== room) {
        return 'ignored'
      }
      const operationId =
        session.operationId ??
        state.committedOperationId ??
        state.activeOperationId
      if (!operationId && state.committed === null) {
        return 'ignored'
      }
      const candidateLost =
        session.status === 'connecting' ||
        session.operationId !== state.committedOperationId
      const reconnectChannelId = candidateLost
        ? session.channelId
        : state.committed ??
          (state.desired.kind === 'channel' ? state.desired.channelId : null)
      if (!expected) {
        setSession({
          operationId,
          room: null,
          channelId: reconnectChannelId,
          status: reconnectChannelId ? 'connecting' : 'idle',
          localVoiceReady: false,
        })
        if (!candidateLost && reconnectChannelId) {
          voiceRejoin.onUnexpectedDisconnect(reconnectChannelId)
        }
      }
      dispatch({ type: 'disconnected', operationId, expected, error })
      return candidateLost ? 'candidate_lost' : 'committed_session_lost'
    },
    observeLocalVoiceReady(room, channelId, ready) {
      if (
        session.room !== room ||
        session.channelId !== channelId ||
        session.status !== 'connected'
      ) {
        return
      }
      setSession({ ...session, localVoiceReady: ready })
    },
    disconnectLocalSession,
    reset: resetExecutor,
    async teardown() {
      const currentRoom = session.room
      const retainedRoom = pendingMoveSource?.source.room ?? null
      resetExecutor()
      await Promise.all([
        disconnectRoom(currentRoom),
        retainedRoom !== currentRoom ? disconnectRoom(retainedRoom) : Promise.resolve(),
      ])
    },
  }
}

function headExpectedCurrentOperationId(
  state: VoiceDirectorState,
  operationId: string,
) {
  const head = state.steps[0]
  if (head?.kind !== 'join' || head.operationId !== operationId) {
    return null
  }
  return head.expectedCurrentOperationId ?? null
}

function headRetainsFinalized(
  state: VoiceDirectorState,
  operationId: string,
) {
  const head = state.steps[0]
  return Boolean(
    head?.kind === 'join' &&
    head.operationId === operationId &&
    head.retainFinalized,
  )
}
