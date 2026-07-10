import { describe, expect, it, vi } from 'vitest'
import type { Room } from 'livekit-client'

import {
  createVoiceIntentExecutor,
  type VoiceExecutorDeps,
  type VoiceIntentExecutorJoinOptions,
  type VoiceIntentExecutorJoinResult,
} from '#/features/voice/voice-intent-executor'
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
    options: VoiceIntentExecutorJoinOptions,
  ) => Promise<VoiceIntentExecutorJoinResult>
  recovery?: Partial<
    Omit<
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
  >
} = {}) {
  return {
    getToken: () => 'token',
    isJoinBlocked: () => false,
    performVoiceJoin: options.performVoiceJoin ?? vi.fn(async () => true),
    requestVoiceLeave: vi.fn(),
    shouldKeepRejoining: () => true,
    startLocalVoiceSetup: vi.fn(),
    onAbort: vi.fn(),
    prepareVisualTransition: vi.fn(),
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
    onSessionChanged: vi.fn(),
    setConnectionPhase: vi.fn(),
    recovery: {
      getGatewayConnected: () => true,
      getUserId: () => 'user-1',
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

function createExecutor(
  deps: VoiceExecutorDeps,
  now: () => number = Date.now,
  commitTimeoutMs = 15_000,
) {
  return createVoiceIntentExecutor({
    getDeps: () => deps,
    now,
    commitTimeoutMs,
  })
}

describe('createVoiceIntentExecutor', () => {
  it('runs server reconciliation inside executor and enqueues a rejoin', async () => {
    const room = {
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(async () => {}),
    } as unknown as Room
    const executor = createExecutor(
      createDeps({
        createOperationId: operationIds('op-rejoin'),
        performVoiceJoin: vi.fn(async () => ({ room })),
        recovery: {
          getVoiceParticipants: () => ({}),
        },
      }),
    )
    executor.requestRejoin('voice-a')
    await flush()
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
        gatewayDispatched: false,
        expectedCurrentOperationId: 'op-rejoin',
      },
    ])
  })

  it('executes an idle join and waits for broadcast commit', async () => {
    const deps = createDeps({ createOperationId: operationIds('op-join-a') })
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    await flush()

    expect(deps.performVoiceJoin).toHaveBeenCalledWith('voice-a', expect.objectContaining({
      operationId: 'op-join-a',
      reason: 'manual_join',
    }))
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
    expect(deps.onSessionChanged).toHaveBeenCalledWith(
      expect.objectContaining({ room, channelId: 'voice-a', status: 'connecting' }),
    )

    await executor.teardown()

    expect(room.removeAllListeners).toHaveBeenCalled()
    expect(room.disconnect).toHaveBeenCalled()
    expect(deps.onSessionChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ room: null, channelId: null, status: 'idle' }),
    )
  })

  it('starts local setup only after room ownership and gateway commit agree', async () => {
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

    expect(executor.getSnapshot()).toMatchObject({
      room,
      channelId: 'voice-a',
      status: 'connecting',
      committedChannelId: null,
    })
    expect(deps.startLocalVoiceSetup).not.toHaveBeenCalled()

    executor.observeCommit('op-join-a', 'voice-a')

    expect(deps.startLocalVoiceSetup).toHaveBeenCalledWith(room, 'voice-a')
    expect(deps.onSessionChanged.mock.invocationCallOrder.at(-1)).toBeLessThan(
      deps.startLocalVoiceSetup.mock.invocationCallOrder[0],
    )
    expect(executor.getSnapshot().status).toBe('connected')
  })

  it('does not let target room events recover against the source roster before move commit', async () => {
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
      recovery: {
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
              version: 2,
            },
          },
        }),
      },
    })
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    await flush()
    executor.observeCommit('op-join-a', 'voice-a')
    executor.intent('voice-b', 'switch')
    await flush()

    executor.reconcileWithServer('participants_changed', targetRoom)
    await flush()

    expect(deps.disconnectLocalSession).not.toHaveBeenCalled()
    expect(deps.disconnectMoveSource).not.toHaveBeenCalled()
    expect(executor.getSnapshot()).toMatchObject({
      room: targetRoom,
      channelId: 'voice-b',
      status: 'connecting',
      committedChannelId: 'voice-a',
    })
  })

  it('repairs a failed publisher only after local setup finishes', async () => {
    const room = {
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(async () => {}),
    } as unknown as Room
    const publisherRepair = deferred<boolean>()
    const startNativeMicrophone = vi.fn(() => publisherRepair.promise)
    const deps = createDeps({
      createOperationId: operationIds('op-join-a'),
      performVoiceJoin: vi.fn(async () => ({ room })),
      recovery: {
        isPublisherHealthy: () => false,
        shouldUseNativeMicrophone: () => true,
        startNativeMicrophone,
      },
    })
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    await flush()
    executor.observeCommit('op-join-a', 'voice-a')

    executor.reconcileWithServer('participants_changed', room)
    await flush()
    expect(startNativeMicrophone).not.toHaveBeenCalled()

    executor.observeLocalVoiceReady(room, 'voice-a', true)
    executor.reconcileWithServer('health_tick', room)
    await flush()
    executor.reconcileWithServer('participants_changed', room)
    await flush()
    expect(startNativeMicrophone).toHaveBeenCalledTimes(1)
    expect(startNativeMicrophone).toHaveBeenCalledWith(room, false)

    publisherRepair.resolve(true)
    await flush()
  })

  it('backs off repeated publisher repair failures for the same voice session', async () => {
    let now = 10_000
    const room = {
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(async () => {}),
    } as unknown as Room
    const startNativeMicrophone = vi.fn(async () => {
      throw new Error('track publication timed out')
    })
    const deps = createDeps({
      createOperationId: operationIds('op-join-a'),
      performVoiceJoin: vi.fn(async () => ({ room })),
      recovery: {
        isPublisherHealthy: () => false,
        shouldUseNativeMicrophone: () => true,
        startNativeMicrophone,
      },
    })
    const executor = createExecutor(deps, () => now)

    executor.intent('voice-a', 'manual_join')
    await flush()
    executor.observeCommit('op-join-a', 'voice-a')
    executor.observeLocalVoiceReady(room, 'voice-a', true)

    executor.reconcileWithServer('local_setup_complete', room)
    await vi.waitFor(() =>
      expect(startNativeMicrophone).toHaveBeenCalledTimes(1),
    )

    executor.reconcileWithServer('participants_changed', room)
    await flush()
    expect(startNativeMicrophone).toHaveBeenCalledTimes(1)

    now += 1_000
    executor.reconcileWithServer('health_tick', room)
    await vi.waitFor(() =>
      expect(startNativeMicrophone).toHaveBeenCalledTimes(2),
    )
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
    expect(deps.onSessionChanged).toHaveBeenCalledWith(
      expect.objectContaining({ room, status: 'connected' }),
    )
    expect(deps.startLocalVoiceSetup).toHaveBeenCalledWith(room, 'voice-a')
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
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    await flush()
    executor.observeCommit('op-join-a', 'voice-a')
    executor.observeLocalVoiceReady(sourceRoom, 'voice-a', true)
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
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    await flush()
    executor.observeCommit('op-join-a', 'voice-a')
    executor.observeLocalVoiceReady(sourceRoom, 'voice-a', true)
    executor.intent('voice-b', 'switch')
    await flush()
    executor.intent('voice-a', 'switch')
    await flush()

    expect(deps.performVoiceJoin).toHaveBeenCalledTimes(2)
    expect(executor.getSnapshot()).toMatchObject({
      room: sourceRoom,
      channelId: 'voice-a',
      status: 'connected',
      localVoiceReady: true,
      committedChannelId: 'voice-a',
      activeOperationId: null,
      phase: 'connected',
    })
    expect(deps.disconnectMoveSource).not.toHaveBeenCalled()
    expect(sourceRoom.disconnect).not.toHaveBeenCalled()
    expect(targetRoom.removeAllListeners).toHaveBeenCalledTimes(1)
    expect(targetRoom.disconnect).toHaveBeenCalledTimes(1)
  })

  it('cancels locally when returning before the target reached the gateway', async () => {
    const sourceRoom = {
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(async () => {}),
    } as unknown as Room
    let callIndex = 0
    const performVoiceJoin = vi.fn(
      async (_channelId: string, options: VoiceIntentExecutorJoinOptions) => {
        callIndex += 1
        if (callIndex === 1) return { room: sourceRoom }
        return await new Promise<false>((resolve) => {
          options.signal.addEventListener('abort', () => resolve(false), {
            once: true,
          })
        })
      },
    )
    const deps = createDeps({
      createOperationId: operationIds('op-join-a', 'op-join-b'),
      performVoiceJoin,
    })
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    await flush()
    executor.observeCommit('op-join-a', 'voice-a')
    executor.observeLocalVoiceReady(sourceRoom, 'voice-a', true)

    executor.intent('voice-b', 'switch')
    await flush()
    executor.intent('voice-a', 'switch')
    await flush()

    expect(performVoiceJoin).toHaveBeenCalledTimes(2)
    expect(
      (performVoiceJoin.mock.calls[1]?.[1] as VoiceIntentExecutorJoinOptions)
        .signal.aborted,
    ).toBe(true)
    expect(executor.getSnapshot()).toMatchObject({
      room: sourceRoom,
      channelId: 'voice-a',
      committedChannelId: 'voice-a',
      activeOperationId: null,
      phase: 'connected',
    })
  })

  it('uses an explicit CAS restore after the target operation reached the gateway', async () => {
    const sourceRoom = {
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(async () => {}),
    } as unknown as Room
    let callIndex = 0
    const performVoiceJoin = vi.fn(
      async (_channelId: string, options: VoiceIntentExecutorJoinOptions) => {
        callIndex += 1
        if (callIndex === 1) return { room: sourceRoom }
        if (callIndex === 2) {
          options.onGatewayDispatched()
          return await new Promise<false>((resolve) => {
            if (options.signal.aborted) {
              resolve(false)
              return
            }
            options.signal.addEventListener('abort', () => resolve(false), {
              once: true,
            })
          })
        }
        return true
      },
    )
    const deps = createDeps({
      createOperationId: operationIds(
        'op-join-a',
        'op-join-b',
        'op-restore-a',
      ),
      performVoiceJoin,
    })
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    await flush()
    executor.observeCommit('op-join-a', 'voice-a')
    executor.observeLocalVoiceReady(sourceRoom, 'voice-a', true)

    executor.intent('voice-b', 'switch')
    await flush()
    expect(executor.getState().steps[0]).toMatchObject({
      operationId: 'op-join-b',
      gatewayDispatched: true,
    })

    executor.intent('voice-a', 'switch')
    await flush()
    await flush()

    expect(performVoiceJoin).toHaveBeenCalledTimes(3)
    expect(
      (performVoiceJoin.mock.calls[1]?.[1] as VoiceIntentExecutorJoinOptions)
        .signal.aborted,
    ).toBe(true)
    expect(performVoiceJoin).toHaveBeenLastCalledWith(
      'voice-a',
      expect.objectContaining({
        operationId: 'op-join-a',
        expectedCurrentOperationId: 'op-join-b',
        reason: 'switch',
      }),
    )
    expect(executor.getState()).toMatchObject({
      desired: { kind: 'channel', channelId: 'voice-a' },
      committed: 'voice-a',
      activeOperationId: 'op-join-a',
    })
    expect(executor.ownsRoom(sourceRoom)).toBe(true)
  })

  it('retains A after a dispatched B times out before the return intent', async () => {
    const sourceRoom = {
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(async () => {}),
    } as unknown as Room
    let callIndex = 0
    const performVoiceJoin = vi.fn(
      async (_channelId: string, options: VoiceIntentExecutorJoinOptions) => {
        callIndex += 1
        if (callIndex === 1) return { room: sourceRoom }
        if (callIndex === 2) {
          options.onGatewayDispatched()
          throw new Error('Voice join timed out')
        }
        return true
      },
    )
    const deps = createDeps({
      createOperationId: operationIds('op-join-a', 'op-join-b'),
      performVoiceJoin,
    })
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    await flush()
    executor.observeCommit('op-join-a', 'voice-a')
    executor.observeLocalVoiceReady(sourceRoom, 'voice-a', true)
    executor.intent('voice-b', 'switch')
    await flush()

    expect(executor.getState()).toMatchObject({
      activeOperationId: null,
      lastError: 'Voice join timed out',
      operationJournal: expect.arrayContaining([
        expect.objectContaining({
          operationId: 'op-join-b',
          gatewayDispatched: true,
          lifecycle: 'failed',
        }),
      ]),
    })

    executor.intent('voice-a', 'switch')
    await flush()

    expect(performVoiceJoin).toHaveBeenCalledTimes(3)
    expect(performVoiceJoin).toHaveBeenLastCalledWith(
      'voice-a',
      expect.objectContaining({
        operationId: 'op-join-a',
        expectedCurrentOperationId: 'op-join-b',
        reuseExistingRoom: true,
      }),
    )
  })

  it('terminates a join that never receives its broadcast commit', async () => {
    vi.useFakeTimers()
    const room = {
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(async () => {}),
    } as unknown as Room
    const deps = createDeps({
      createOperationId: operationIds('op-join-a'),
      performVoiceJoin: vi.fn(async () => ({ room })),
    })
    const executor = createExecutor(deps, Date.now, 50)

    try {
      executor.intent('voice-a', 'manual_join')
      await flush()
      expect(executor.getSnapshot().status).toBe('connecting')

      await vi.advanceTimersByTimeAsync(50)
      await flush()

      expect(executor.getSnapshot()).toMatchObject({
        room: null,
        status: 'idle',
        activeOperationId: null,
        lastError: 'Voice commit timed out for voice-a',
      })
      expect(room.disconnect).toHaveBeenCalledTimes(1)
    } finally {
      await executor.teardown()
      vi.useRealTimers()
    }
  })

  it('restarts unfinished local setup when restoring the move source', async () => {
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
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    await flush()
    executor.observeCommit('op-join-a', 'voice-a')
    expect(deps.startLocalVoiceSetup).toHaveBeenCalledTimes(1)

    executor.intent('voice-b', 'switch')
    await flush()
    executor.intent('voice-a', 'switch')

    expect(deps.startLocalVoiceSetup).toHaveBeenCalledTimes(2)
    expect(deps.startLocalVoiceSetup).toHaveBeenLastCalledWith(
      sourceRoom,
      'voice-a',
    )
    expect(executor.getSnapshot()).toMatchObject({
      room: sourceRoom,
      channelId: 'voice-a',
      status: 'connected',
      localVoiceReady: false,
    })
  })

  it('does not start a second native repair lineage while restored A local setup is still restarting', async () => {
    const sourceRoom = {
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(async () => {}),
    } as unknown as Room
    const targetRoom = {
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(async () => {}),
    } as unknown as Room
    const startNativeMicrophone = vi.fn(async () => true)
    const deps = createDeps({
      createOperationId: operationIds('op-join-a', 'op-join-b'),
      performVoiceJoin: vi
        .fn()
        .mockResolvedValueOnce({ room: sourceRoom })
        .mockResolvedValueOnce({ room: targetRoom }),
      recovery: {
        isPublisherHealthy: () => false,
        shouldUseNativeMicrophone: () => true,
        startNativeMicrophone,
      },
    })
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    await flush()
    executor.observeCommit('op-join-a', 'voice-a')
    expect(deps.startLocalVoiceSetup).toHaveBeenCalledTimes(1)

    executor.intent('voice-b', 'switch')
    await flush()
    executor.intent('voice-a', 'switch')
    await flush()

    expect(executor.getSnapshot()).toMatchObject({
      room: sourceRoom,
      channelId: 'voice-a',
      status: 'connected',
      localVoiceReady: false,
      committedChannelId: 'voice-a',
    })

    executor.reconcileWithServer('health_tick', sourceRoom)
    executor.reconcileWithServer('participants_changed', sourceRoom)
    await flush()

    expect(startNativeMicrophone).not.toHaveBeenCalled()

    executor.observeLocalVoiceReady(sourceRoom, 'voice-a', true)
    executor.reconcileWithServer('health_tick', sourceRoom)
    await vi.waitFor(() =>
      expect(startNativeMicrophone).toHaveBeenCalledTimes(1),
    )
    expect(startNativeMicrophone).toHaveBeenCalledWith(sourceRoom, false)
  })

  it('rejoins the source instead of restoring it after the retained room is lost', async () => {
    const sourceRoom = {
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(async () => {}),
    } as unknown as Room
    const targetRoom = {
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(async () => {}),
    } as unknown as Room
    const deps = createDeps({
      createOperationId: operationIds(
        'op-join-a',
        'op-join-b',
        'op-rejoin-a',
      ),
      performVoiceJoin: vi
        .fn()
        .mockResolvedValueOnce({ room: sourceRoom })
        .mockResolvedValueOnce({ room: targetRoom })
        .mockResolvedValueOnce(true),
    })
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    await flush()
    executor.observeCommit('op-join-a', 'voice-a')
    executor.intent('voice-b', 'switch')
    await flush()

    expect(executor.ownsRoom(sourceRoom)).toBe(true)
    expect(
      executor.onRoomDisconnected(sourceRoom, false, 'Source disconnected'),
    ).toBe('retained_source_lost')
    expect(executor.ownsRoom(sourceRoom)).toBe(false)

    executor.intent('voice-a', 'switch')
    await flush()

    expect(deps.performVoiceJoin).toHaveBeenCalledTimes(3)
    expect(deps.performVoiceJoin).toHaveBeenLastCalledWith('voice-a', expect.objectContaining({
      operationId: 'op-rejoin-a',
      reason: 'rejoin',
    }))
    expect(targetRoom.disconnect).toHaveBeenCalledTimes(1)
  })

  it('keeps the retained source and retries a failed candidate only on a new intent', async () => {
    const sourceRoom = {
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(async () => {}),
    } as unknown as Room
    const targetRoom = {
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(async () => {}),
    } as unknown as Room
    const deps = createDeps({
      createOperationId: operationIds(
        'op-join-a',
        'op-join-b',
        'op-join-b-retry',
      ),
      performVoiceJoin: vi
        .fn()
        .mockResolvedValueOnce({ room: sourceRoom })
        .mockResolvedValueOnce({ room: targetRoom })
        .mockResolvedValueOnce(true),
    })
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    await flush()
    executor.observeCommit('op-join-a', 'voice-a')
    executor.intent('voice-b', 'switch')
    await flush()

    expect(
      executor.onRoomDisconnected(targetRoom, false, 'Target disconnected'),
    ).toBe('candidate_lost')
    await flush()
    expect(deps.performVoiceJoin).toHaveBeenCalledTimes(2)

    executor.intent('voice-b', 'switch')
    await flush()

    expect(deps.performVoiceJoin).toHaveBeenLastCalledWith('voice-b', expect.objectContaining({
      operationId: 'op-join-b-retry',
      reason: 'switch',
    }))
    expect(executor.ownsRoom(sourceRoom)).toBe(true)
    expect(deps.disconnectMoveSource).not.toHaveBeenCalled()
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
    expect(deps.performVoiceJoin).toHaveBeenLastCalledWith('voice-b', expect.objectContaining({
      operationId: 'op-join-b',
      reason: 'switch',
    }))
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
    expect(deps.onSessionChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ room: null, channelId: null, status: 'idle' }),
    )
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
    expect(deps.onSessionChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ room: null, channelId: null, status: 'idle' }),
    )
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
    expect(deps.onSessionChanged).not.toHaveBeenCalledWith(
      expect.objectContaining({ room }),
    )
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
    executor.onRoomDisconnected(room, false, 'Room disconnected')
    await flush()

    expect(executor.getRoom()).toBeNull()
    expect(deps.onSessionChanged).toHaveBeenCalledWith(
      expect.objectContaining({ room: null, status: 'connecting' }),
    )
    expect(deps.performVoiceJoin).toHaveBeenLastCalledWith('voice-a', expect.objectContaining({
      operationId: 'op-rejoin-a',
      reason: 'rejoin',
    }))
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

    expect(deps.performVoiceJoin).toHaveBeenLastCalledWith('voice-a', expect.objectContaining({
      operationId: 'op-rejoin-a',
      reason: 'rejoin',
    }))
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
    expect(deps.performVoiceJoin).toHaveBeenLastCalledWith('voice-a', expect.objectContaining({
      operationId: 'op-rejoin-a',
      reason: 'rejoin',
    }))
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
    expect(deps.performVoiceJoin).toHaveBeenLastCalledWith('voice-b', expect.objectContaining({
      operationId: 'op-join-b',
      reason: 'switch',
    }))
    expect(executor.getState()).toMatchObject({
      desired: { kind: 'channel', channelId: 'voice-b' },
      committed: null,
      activeOperationId: 'op-join-b',
    })
  })

  it('stops after a thrown join and allows an explicit same-intent retry', async () => {
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

    expect(deps.performVoiceJoin).toHaveBeenCalledTimes(1)
    expect(executor.getState()).toMatchObject({
      desired: { kind: 'channel', channelId: 'voice-a' },
      activeOperationId: null,
      lastError: 'timeout',
    })

    executor.intent('voice-a', 'manual_join')
    await flush()
    expect(deps.performVoiceJoin).toHaveBeenCalledTimes(2)
    expect(executor.getState().activeOperationId).toBe('op-join-a-retry')
  })

  it('stops after a false join result and allows an explicit same-intent retry', async () => {
    const deps = createDeps({
      createOperationId: operationIds('op-join-a', 'op-join-a-retry'),
      performVoiceJoin: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
    })
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    await flush()

    expect(deps.performVoiceJoin).toHaveBeenCalledTimes(1)
    expect(executor.getState()).toMatchObject({
      desired: { kind: 'channel', channelId: 'voice-a' },
      activeOperationId: null,
      lastError: 'Voice join was aborted',
    })

    executor.intent('voice-a', 'manual_join')
    await flush()
    expect(deps.performVoiceJoin).toHaveBeenCalledTimes(2)
    expect(executor.getState().activeOperationId).toBe('op-join-a-retry')
  })

  it('records late authoritative commits and accepts the current join commit', async () => {
    const deps = createDeps({ createOperationId: operationIds('op-join-a', 'op-join-b') })
    const executor = createExecutor(deps)

    executor.intent('voice-a', 'manual_join')
    executor.intent('voice-b', 'switch')
    await flush()

    executor.observeCommit('op-join-a', 'voice-a')
    expect(executor.getState().committed).toBe('voice-a')

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
    expect(deps.performVoiceJoin).toHaveBeenLastCalledWith('voice-c', expect.objectContaining({
      operationId: 'op-join-c',
      reason: 'switch',
    }))
  })
})
