import { describe, expect, it, vi } from 'vitest'
import type { Room } from 'livekit-client'

import {
  createVoiceIntentExecutor,
  type VoiceExecutorDeps,
  type VoiceIntentExecutorJoinResult,
} from '#/features/voice/voice-intent-executor'
import type { VoiceJoinReason } from '#/features/voice/voice-intent-director'
import type { ActiveVoiceSessionSnapshot } from '#/features/voice/voice-join'
import type { VoiceRecoveryRunnerDeps } from '#/features/voice/voice-recovery-runner'

function operationIds(...ids: string[]) {
  let index = 0
  return () => ids[index++] ?? `op-${index++}`
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

function createDeps(options: {
  createOperationId?: () => string
  performVoiceJoin?: (
    channelId: string,
    options: { operationId: string; reason: VoiceJoinReason },
  ) => Promise<VoiceIntentExecutorJoinResult>
  recovery?: Partial<
    Omit<
      VoiceRecoveryRunnerDeps,
      | 'getDesiredChannelId'
      | 'getRoom'
      | 'requestRejoinOperation'
      | 'stopRemoteSupersededVoiceSession'
      | 'getPendingRejoinChannelId'
      | 'getJoinInFlight'
      | 'setJoinInFlight'
    >
  >
} = {}) {
  return {
    getToken: () => 'token',
    getLocalUserId: () => 'user-1',
    isJoinBlocked: () => false,
    getActiveSession: (): ActiveVoiceSessionSnapshot | null => null,
    performVoiceJoin: options.performVoiceJoin ?? vi.fn(async () => true),
    requestVoiceLeave: vi.fn(),
    shouldKeepRejoining: () => true,
    attachRoomHandlers: vi.fn(),
    onRoomConnected: vi.fn(),
    onAbort: vi.fn(),
    beginVisualTransition: vi.fn(),
    clearVisualPresence: vi.fn(),
    completeTerminalLeave: vi.fn(async ({ room }: { room: Room | null }) => {
      room?.removeAllListeners()
      await room?.disconnect().catch(() => {})
    }),
    disconnectLocalSession: vi.fn(async ({ room }: { room: Room | null }) => {
      room?.removeAllListeners()
      await room?.disconnect().catch(() => {})
    }),
    disconnectMoveSource: vi.fn(async ({ room }: { room: Room }) => {
      room.removeAllListeners()
      await room.disconnect().catch(() => {})
    }),
    onRoomChanged: vi.fn(),
    setLiveKitCredentials: vi.fn(),
    setConnectionPhase: vi.fn(),
    recovery: {
      getGatewayConnected: () => true,
      getActiveChannelId: () => 'voice-a',
      getUserId: () => 'user-1',
      getStatus: () => 'connected' as const,
      getVoiceParticipants: () => ({
        'voice-a': {
          'user-1': {
            id: 'user-1',
            joined_at: 1,
            self_mute: false,
            self_deaf: false,
            server_muted: false,
            server_deafened: false,
            camera: false,
            screensharing: false,
            version: 1,
          },
        },
      }),
      canTrustServerState: () => true,
      readCurrentVoiceFlags: () => ({ selfMute: false, selfDeaf: false }),
      readVoicePreferences: () => ({ micEnabled: true }),
      isSelfMonitoringActive: () => false,
      isPublisherHealthy: () => true,
      syncVoiceFlagsToGateway: vi.fn(),
      shouldUseNativeMicrophone: () => false,
      startNativeMicrophone: vi.fn(async () => true),
      isCurrentVoiceSession: () => true,
      syncMicFromRoom: vi.fn(),
      syncRoomParticipants: vi.fn(),
      syncLocalSpeakingTrack: vi.fn(),
      activeChannelAudioBitrateKbps: () => 64,
      applyMicProcessing: vi.fn(async () => {}),
      getSelfDeafened: () => false,
      ...options.recovery,
    },
    createOperationId: options.createOperationId ?? operationIds('op-join'),
  }
}

function createExecutor(deps: VoiceExecutorDeps) {
  return createVoiceIntentExecutor({ getDeps: () => deps })
}

describe('createVoiceIntentExecutor', () => {
  it('runs server reconciliation inside executor and enqueues a rejoin', async () => {
    const executor = createExecutor(
      createDeps({
        createOperationId: operationIds('op-rejoin'),
        recovery: {
          getVoiceParticipants: () => ({}),
        },
      }),
    )
    executor.requestRejoin('voice-a')
    executor.observeCommit('op-rejoin', 'voice-a')

    executor.reconcileWithServer('gateway_connected')

    await flush()
    expect(executor.getState().activeOperationId).toBe('op-2')
    expect(executor.getState().steps).toEqual([
      {
        kind: 'join',
        operationId: 'op-2',
        channelId: 'voice-a',
        reason: 'rejoin',
      },
    ])
  })

  it('executes an idle join and waits for broadcast commit', async () => {
    const deps = createDeps({ createOperationId: operationIds('op-join-a') })
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    await flush()

    expect(deps.performVoiceJoin).toHaveBeenCalledWith('voice-a', {
      operationId: 'op-join-a',
      reason: 'manual_join',
    })
    expect(executor.getState()).toMatchObject({
      committed: null,
      activeOperationId: 'op-join-a',
      phase: 'joining',
    })

    executor.observeCommit('op-join-a', 'voice-a')

    expect(executor.getSnapshot()).toMatchObject({
      committedChannelId: 'voice-a',
      activeOperationId: null,
      phase: 'connected',
    })
  })

  it('owns the room returned by the join runner', async () => {
    const room = {
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(async () => {}),
    } as unknown as Room
    const deps = createDeps({
      createOperationId: operationIds('op-join-a'),
      performVoiceJoin: vi.fn(async () => ({ room })),
    })
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    await flush()

    expect(executor.getRoom()).toBe(room)
    expect(executor.getSnapshot().room).toBe(room)
    expect(deps.onRoomChanged).toHaveBeenCalledWith(room)

    await executor.teardown()

    expect(room.removeAllListeners).toHaveBeenCalled()
    expect(room.disconnect).toHaveBeenCalled()
    expect(deps.onRoomChanged).toHaveBeenLastCalledWith(null)
  })

  it('accepts a committed join result when gateway commit arrives before the room resolves', async () => {
    const joinedRoom = deferred<{ room: Room }>()
    const room = {
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(async () => {}),
    } as unknown as Room
    const deps = createDeps({
      createOperationId: operationIds('op-join-a'),
      performVoiceJoin: vi.fn(() => joinedRoom.promise),
    })
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    await flush()
    executor.observeCommit('op-join-a', 'voice-a')
    joinedRoom.resolve({ room })
    await flush()

    expect(executor.getRoom()).toBe(room)
    expect(deps.onRoomChanged).toHaveBeenCalledWith(room)
    expect(executor.getSnapshot()).toMatchObject({
      room,
      committedChannelId: 'voice-a',
      activeOperationId: null,
      phase: 'connected',
    })
  })

  it('finalizes the move source once when commit arrives before the target room resolves', async () => {
    const targetJoin = deferred<{ room: Room }>()
    const sourceRoom = {
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(async () => {}),
    } as unknown as Room
    const targetRoom = {
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(async () => {}),
    } as unknown as Room
    const deps = createDeps({
      createOperationId: operationIds('op-join-a', 'op-join-b'),
      performVoiceJoin: vi
        .fn()
        .mockResolvedValueOnce({ room: sourceRoom })
        .mockReturnValueOnce(targetJoin.promise),
    })
    deps.getActiveSession = () => ({
      room: sourceRoom,
      channelId: 'voice-a',
      localVoiceReady: true,
    })
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    await flush()
    executor.observeCommit('op-join-a', 'voice-a')
    executor.intent('voice-b', 'switch')
    await flush()
    executor.observeCommit('op-join-b', 'voice-b')
    targetJoin.resolve({ room: targetRoom })
    await flush()

    expect(executor.getRoom()).toBe(targetRoom)
    expect(deps.disconnectMoveSource).toHaveBeenCalledTimes(1)
    expect(deps.disconnectMoveSource).toHaveBeenCalledWith({
      operationId: 'op-join-b',
      room: sourceRoom,
      channelId: 'voice-a',
      localVoiceReady: true,
    })
    expect(sourceRoom.removeAllListeners).toHaveBeenCalledTimes(1)
    expect(sourceRoom.disconnect).toHaveBeenCalledTimes(1)
  })

  it('restores the move source without a backend join when intent returns before commit', async () => {
    const sourceRoom = {
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(async () => {}),
    } as unknown as Room
    const targetRoom = {
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(async () => {}),
    } as unknown as Room
    const deps = createDeps({
      createOperationId: operationIds('op-join-a', 'op-join-b'),
      performVoiceJoin: vi
        .fn()
        .mockResolvedValueOnce({ room: sourceRoom })
        .mockResolvedValueOnce({ room: targetRoom }),
    })
    deps.getActiveSession = () => ({
      room: sourceRoom,
      channelId: 'voice-a',
      localVoiceReady: true,
    })
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    await flush()
    executor.observeCommit('op-join-a', 'voice-a')
    executor.intent('voice-b', 'switch')
    await flush()
    executor.intent('voice-a', 'switch')
    await flush()

    expect(deps.performVoiceJoin).toHaveBeenCalledTimes(2)
    expect(executor.getSnapshot()).toMatchObject({
      room: sourceRoom,
      committedChannelId: 'voice-a',
      activeOperationId: null,
      phase: 'connected',
    })
    expect(deps.disconnectMoveSource).not.toHaveBeenCalled()
    expect(sourceRoom.disconnect).not.toHaveBeenCalled()
    expect(targetRoom.removeAllListeners).toHaveBeenCalledTimes(1)
    expect(targetRoom.disconnect).toHaveBeenCalledTimes(1)
  })

  it('starts a server-side replace join without firing a gateway leave', async () => {
    const deps = createDeps({
      createOperationId: operationIds('op-join-a', 'op-join-b'),
    })
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    await flush()
    executor.observeCommit('op-join-a', 'voice-a')
    executor.intent('voice-b', 'switch')
    await flush()

    expect(deps.requestVoiceLeave).not.toHaveBeenCalled()
    expect(deps.clearVisualPresence).not.toHaveBeenCalled()
    expect(deps.performVoiceJoin).toHaveBeenLastCalledWith('voice-b', {
      operationId: 'op-join-b',
      reason: 'switch',
    })
  })

  it('runs terminal leave cleanup for clearIntent on a connected room', async () => {
    const room = {
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(async () => {}),
    } as unknown as Room
    const deps = createDeps({
      createOperationId: operationIds('op-join-a', 'op-leave-a'),
      performVoiceJoin: vi.fn(async () => ({ room })),
    })
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    await flush()
    executor.observeCommit('op-join-a', 'voice-a')
    executor.clearIntent()
    await flush()

    expect(deps.requestVoiceLeave).toHaveBeenCalledTimes(1)
    expect(deps.clearVisualPresence).toHaveBeenCalledWith('voice-a')
    expect(room.removeAllListeners).toHaveBeenCalled()
    expect(room.disconnect).toHaveBeenCalled()
    expect(deps.onRoomChanged).toHaveBeenLastCalledWith(null)
    expect(executor.getSnapshot()).toMatchObject({
      room: null,
      committedChannelId: null,
      activeOperationId: null,
      phase: 'idle',
    })
  })

  it('disconnects a local superseded session without sending gateway leave', async () => {
    const room = {
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(async () => {}),
    } as unknown as Room
    const deps = createDeps({
      createOperationId: operationIds('op-join-a'),
      performVoiceJoin: vi.fn(async () => ({ room })),
    })
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    await flush()
    executor.observeCommit('op-join-a', 'voice-a')
    await executor.disconnectLocalSession()

    expect(deps.requestVoiceLeave).not.toHaveBeenCalled()
    expect(deps.disconnectLocalSession).toHaveBeenCalledWith({
      channelId: 'voice-a',
      room,
    })
    expect(room.removeAllListeners).toHaveBeenCalled()
    expect(room.disconnect).toHaveBeenCalled()
    expect(deps.onRoomChanged).toHaveBeenLastCalledWith(null)
    expect(executor.getSnapshot()).toMatchObject({
      room: null,
      committedChannelId: null,
      activeOperationId: null,
      phase: 'idle',
    })
  })

  it('owns remote supersede disconnects and deduplicates concurrent requests', async () => {
    const room = {
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(async () => {}),
    } as unknown as Room
    const disconnect = deferred<void>()
    const deps = createDeps({
      createOperationId: operationIds('op-join-a'),
      performVoiceJoin: vi.fn(async () => ({ room })),
    })
    deps.disconnectLocalSession.mockReturnValue(disconnect.promise)
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    await flush()
    executor.observeCommit('op-join-a', 'voice-a')
    executor.observeSupersede('gateway:joined_elsewhere', 'voice-b')
    executor.observeSupersede('gateway:moved_elsewhere', 'voice-b')

    expect(deps.requestVoiceLeave).not.toHaveBeenCalled()
    expect(deps.disconnectLocalSession).toHaveBeenCalledTimes(1)
    expect(deps.disconnectLocalSession).toHaveBeenCalledWith({
      channelId: 'voice-a',
      room,
    })

    disconnect.resolve()
    await flush()

    expect(executor.getSnapshot()).toMatchObject({
      room: null,
      committedChannelId: null,
      activeOperationId: null,
      phase: 'idle',
    })
  })

  it('cancels an in-flight join when intent is cleared', async () => {
    const firstJoin = deferred<{ room: Room }>()
    const room = {
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(async () => {}),
    } as unknown as Room
    const deps = createDeps({
      createOperationId: operationIds('op-join-a'),
      performVoiceJoin: vi.fn(() => firstJoin.promise),
    })
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    executor.clearIntent()
    firstJoin.resolve({ room })
    await flush()

    expect(executor.getSnapshot()).toMatchObject({
      room: null,
      committedChannelId: null,
      activeOperationId: null,
      phase: 'idle',
    })
    expect(deps.onRoomChanged).not.toHaveBeenCalledWith(room)
  })

  it('clears room and replans when a committed room disconnects unexpectedly', async () => {
    const room = {
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(async () => {}),
    } as unknown as Room
    const deps = createDeps({
      createOperationId: operationIds('op-join-a', 'op-rejoin-a'),
      performVoiceJoin: vi.fn().mockResolvedValueOnce({ room }).mockResolvedValueOnce(true),
    })
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    await flush()
    executor.observeCommit('op-join-a', 'voice-a')
    executor.onRoomDisconnected(false, 'Room disconnected')
    await flush()

    expect(executor.getRoom()).toBeNull()
    expect(deps.onRoomChanged).toHaveBeenLastCalledWith(null)
    expect(deps.performVoiceJoin).toHaveBeenLastCalledWith('voice-a', {
      operationId: 'op-rejoin-a',
      reason: 'rejoin',
    })
    expect(executor.getState()).toMatchObject({
      desired: { kind: 'channel', channelId: 'voice-a' },
      committed: null,
      activeOperationId: 'op-rejoin-a',
      phase: 'joining',
      lastError: 'Room disconnected',
    })
  })

  it('starts a rejoin operation from an external disconnect observation', async () => {
    const deps = createDeps({
      createOperationId: operationIds('op-join-a', 'op-rejoin-a'),
    })
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    await flush()
    executor.observeCommit('op-join-a', 'voice-a')
    executor.observeDisconnected('op-join-a', false, 'gateway reconnect drift')
    await flush()

    expect(deps.performVoiceJoin).toHaveBeenLastCalledWith('voice-a', {
      operationId: 'op-rejoin-a',
      reason: 'rejoin',
    })
    expect(executor.getState()).toMatchObject({
      desired: { kind: 'channel', channelId: 'voice-a' },
      committed: null,
      activeOperationId: 'op-rejoin-a',
      phase: 'joining',
      lastError: 'gateway reconnect drift',
    })
  })

  it('returns the executor-owned operation id for a recovery rejoin request', async () => {
    const deps = createDeps({
      createOperationId: operationIds('op-join-a', 'op-rejoin-a'),
    })
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    await flush()
    executor.observeCommit('op-join-a', 'voice-a')
    const operationId = executor.requestRejoin('voice-a')
    await flush()

    expect(operationId).toBe('op-rejoin-a')
    expect(deps.performVoiceJoin).toHaveBeenLastCalledWith('voice-a', {
      operationId: 'op-rejoin-a',
      reason: 'rejoin',
    })
  })

  it('ignores a superseded join result and executes the latest intent', async () => {
    const firstJoin = deferred<boolean>()
    const deps = createDeps({
      createOperationId: operationIds('op-join-a', 'op-join-b'),
      performVoiceJoin: vi
        .fn()
        .mockReturnValueOnce(firstJoin.promise)
        .mockResolvedValueOnce(true),
    })
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    executor.intent('voice-b', 'switch')
    firstJoin.resolve(true)
    await flush()

    expect(deps.performVoiceJoin).toHaveBeenCalledTimes(2)
    expect(deps.performVoiceJoin).toHaveBeenLastCalledWith('voice-b', {
      operationId: 'op-join-b',
      reason: 'switch',
    })
    expect(executor.getState()).toMatchObject({
      desired: { kind: 'channel', channelId: 'voice-b' },
      committed: null,
      activeOperationId: 'op-join-b',
    })
  })

  it('keeps desired and replans when the current join throws', async () => {
    const deps = createDeps({
      createOperationId: operationIds('op-join-a', 'op-join-a-retry'),
      performVoiceJoin: vi
        .fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce(true),
    })
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    await flush()

    expect(deps.performVoiceJoin).toHaveBeenCalledTimes(2)
    expect(executor.getState()).toMatchObject({
      desired: { kind: 'channel', channelId: 'voice-a' },
      activeOperationId: 'op-join-a-retry',
      lastError: 'timeout',
    })
  })

  it('keeps desired and replans when the current join returns false', async () => {
    const deps = createDeps({
      createOperationId: operationIds('op-join-a', 'op-join-a-retry'),
      performVoiceJoin: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
    })
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    await flush()

    expect(deps.performVoiceJoin).toHaveBeenCalledTimes(2)
    expect(executor.getState()).toMatchObject({
      desired: { kind: 'channel', channelId: 'voice-a' },
      activeOperationId: 'op-join-a-retry',
      lastError: 'Voice join was aborted',
    })
  })

  it('ignores stale commits and accepts the current join commit', async () => {
    const deps = createDeps({ createOperationId: operationIds('op-join-a', 'op-join-b') })
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    executor.intent('voice-b', 'switch')
    await flush()

    executor.observeCommit('op-join-a', 'voice-a')
    expect(executor.getState().committed).toBeNull()

    executor.observeCommit('op-join-b', 'voice-b')
    expect(executor.getSnapshot()).toMatchObject({
      committedChannelId: 'voice-b',
      phase: 'connected',
    })
  })

  it('supersedes an in-flight replace join when intent changes again', async () => {
    const deps = createDeps({
      createOperationId: operationIds(
        'op-join-a',
        'op-join-b',
        'op-join-c',
      ),
    })
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    await flush()
    executor.observeCommit('op-join-a', 'voice-a')
    executor.intent('voice-b', 'switch')
    executor.intent('voice-c', 'switch')
    await flush()

    expect(deps.requestVoiceLeave).not.toHaveBeenCalled()
    expect(deps.performVoiceJoin).toHaveBeenCalledTimes(3)
    expect(deps.performVoiceJoin).toHaveBeenLastCalledWith('voice-c', {
      operationId: 'op-join-c',
      reason: 'switch',
    })
  })
})
