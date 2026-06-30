import { describe, expect, it } from 'vitest'

import {
  createInitialDirectorState,
  reduceDirector,
  type VoiceDirectorState,
} from '#/features/voice/voice-intent-director'

function operationIds(...ids: string[]) {
  let index = 0
  return () => ids[index++] ?? `op-${index++}`
}

function committedState(channelId: string): VoiceDirectorState {
  return {
    desired: { kind: 'channel', channelId },
    committed: channelId,
    committedOperationId: null,
    phase: 'connected',
    steps: [],
    activeOperationId: null,
    supersededOperationIds: [],
    lastError: null,
  }
}

describe('reduceDirector', () => {
  it('plans a join from idle', () => {
    const state = reduceDirector(
      createInitialDirectorState(),
      { type: 'intent', channelId: 'voice-a', reason: 'manual_join' },
      operationIds('op-join-a'),
    )

    expect(state).toMatchObject({
      desired: { kind: 'channel', channelId: 'voice-a' },
      committed: null,
      phase: 'joining',
      activeOperationId: 'op-join-a',
      steps: [
        {
          kind: 'join',
          operationId: 'op-join-a',
          channelId: 'voice-a',
          reason: 'manual_join',
        },
      ],
    })
  })

  it('keeps identity when intent is unchanged', () => {
    const state = reduceDirector(
      createInitialDirectorState(),
      { type: 'intent', channelId: 'voice-a', reason: 'manual_join' },
      operationIds('op-join-a'),
    )

    const next = reduceDirector(
      state,
      { type: 'intent', channelId: 'voice-a', reason: 'manual_join' },
      operationIds('op-unused'),
    )

    expect(next).toBe(state)
  })

  it('commits a matching desired join', () => {
    const joining = reduceDirector(
      createInitialDirectorState(),
      { type: 'intent', channelId: 'voice-a', reason: 'manual_join' },
      operationIds('op-join-a'),
    )

    const committed = reduceDirector(
      joining,
      { type: 'commit', operationId: 'op-join-a', channelId: 'voice-a' },
      operationIds('op-unused'),
    )

    expect(committed).toMatchObject({
      desired: { kind: 'channel', channelId: 'voice-a' },
      committed: 'voice-a',
      phase: 'connected',
      steps: [],
      activeOperationId: null,
    })
  })

  it('ignores a commit for an irrelevant channel', () => {
    const joining = reduceDirector(
      createInitialDirectorState(),
      { type: 'intent', channelId: 'voice-a', reason: 'manual_join' },
      operationIds('op-join-a'),
    )

    const next = reduceDirector(
      joining,
      { type: 'commit', operationId: 'op-join-a', channelId: 'voice-b' },
      operationIds('op-unused'),
    )

    expect(next).toBe(joining)
  })

  it('plans a server-side replace join when moving from another committed channel', () => {
    const state = reduceDirector(
      committedState('voice-a'),
      { type: 'intent', channelId: 'voice-b', reason: 'switch' },
      operationIds('op-join-b'),
    )

    expect(state).toMatchObject({
      desired: { kind: 'channel', channelId: 'voice-b' },
      committed: 'voice-a',
      phase: 'joining',
      activeOperationId: 'op-join-b',
      steps: [
        {
          kind: 'join',
          operationId: 'op-join-b',
          channelId: 'voice-b',
          reason: 'switch',
        },
      ],
    })
  })

  it('coalesces A to B to C by preserving only the latest server-side replace join', () => {
    const movingToB = reduceDirector(
      committedState('voice-a'),
      { type: 'intent', channelId: 'voice-b', reason: 'switch' },
      operationIds('op-join-b'),
    )

    const movingToC = reduceDirector(
      movingToB,
      { type: 'intent', channelId: 'voice-c', reason: 'switch' },
      operationIds('op-join-c'),
    )

    expect(movingToC.steps).toEqual([
      {
        kind: 'join',
        operationId: 'op-join-c',
        channelId: 'voice-c',
        reason: 'switch',
      },
    ])
    expect(movingToC.supersededOperationIds).toContain('op-join-b')
  })

  it('supersedes an in-flight idle join with the latest intent', () => {
    const joiningA = reduceDirector(
      createInitialDirectorState(),
      { type: 'intent', channelId: 'voice-a', reason: 'manual_join' },
      operationIds('op-join-a'),
    )

    const joiningB = reduceDirector(
      joiningA,
      { type: 'intent', channelId: 'voice-b', reason: 'switch' },
      operationIds('op-join-b'),
    )

    expect(joiningB.steps).toEqual([
      {
        kind: 'join',
        operationId: 'op-join-b',
        channelId: 'voice-b',
        reason: 'switch',
      },
    ])
    expect(joiningB.activeOperationId).toBe('op-join-b')
    expect(joiningB.supersededOperationIds).toContain('op-join-a')
  })

  it('ignores stale commits for superseded operations', () => {
    const joiningA = reduceDirector(
      createInitialDirectorState(),
      { type: 'intent', channelId: 'voice-a', reason: 'manual_join' },
      operationIds('op-join-a'),
    )
    const joiningB = reduceDirector(
      joiningA,
      { type: 'intent', channelId: 'voice-b', reason: 'switch' },
      operationIds('op-join-b'),
    )

    const stale = reduceDirector(
      joiningB,
      { type: 'commit', operationId: 'op-join-a', channelId: 'voice-a' },
      operationIds('op-unused'),
    )

    expect(stale).toBe(joiningB)
  })

  it('does not let local restore events advance committed state', () => {
    const joining = reduceDirector(
      createInitialDirectorState(),
      { type: 'intent', channelId: 'voice-a', reason: 'manual_join' },
      operationIds('op-join-a'),
    )

    const restored = reduceDirector(
      joining,
      { type: 'restore_commit', channelId: 'voice-a' } as never,
      operationIds('op-unused'),
    )

    expect(restored).toBe(joining)
  })

  it('plans a hard leave when clearing connected intent', () => {
    const state = reduceDirector(
      committedState('voice-a'),
      { type: 'clear_intent' },
      operationIds('op-leave-a'),
    )

    expect(state).toMatchObject({
      desired: { kind: 'none' },
      committed: 'voice-a',
      phase: 'leaving',
      activeOperationId: 'op-leave-a',
      steps: [
        { kind: 'hard_leave', operationId: 'op-leave-a', channelId: 'voice-a' },
      ],
    })
  })

  it('finishes the current hard leave when leave is observed', () => {
    const leaving = reduceDirector(
      committedState('voice-a'),
      { type: 'clear_intent' },
      operationIds('op-leave-a'),
    )

    const idle = reduceDirector(
      leaving,
      { type: 'leave_observed', operationId: 'op-leave-a' },
      operationIds('op-unused'),
    )

    expect(idle).toMatchObject({
      desired: { kind: 'none' },
      committed: null,
      phase: 'idle',
      steps: [],
      activeOperationId: null,
    })
  })

  it('keeps desired and replans when the current step fails', () => {
    const joining = reduceDirector(
      createInitialDirectorState(),
      { type: 'intent', channelId: 'voice-a', reason: 'manual_join' },
      operationIds('op-join-a'),
    )

    const retried = reduceDirector(
      joining,
      { type: 'step_failed', operationId: 'op-join-a', error: 'timeout' },
      operationIds('op-join-a-retry'),
    )

    expect(retried).toMatchObject({
      desired: { kind: 'channel', channelId: 'voice-a' },
      committed: null,
      phase: 'joining',
      activeOperationId: 'op-join-a-retry',
      lastError: 'timeout',
      steps: [
        {
          kind: 'join',
          operationId: 'op-join-a-retry',
          channelId: 'voice-a',
          reason: 'manual_join',
        },
      ],
    })
  })

  it('replans rejoin when the committed operation disconnects unexpectedly', () => {
    const connected = reduceDirector(
      reduceDirector(
        createInitialDirectorState(),
        { type: 'intent', channelId: 'voice-a', reason: 'manual_join' },
        operationIds('op-join-a'),
      ),
      { type: 'commit', operationId: 'op-join-a', channelId: 'voice-a' },
      operationIds('op-unused'),
    )

    const recovering = reduceDirector(
      connected,
      {
        type: 'disconnected',
        operationId: 'op-join-a',
        expected: false,
        error: 'gateway reconnect drift',
      },
      operationIds('op-rejoin-a'),
    )

    expect(recovering).toMatchObject({
      desired: { kind: 'channel', channelId: 'voice-a' },
      committed: null,
      activeOperationId: 'op-rejoin-a',
      phase: 'joining',
      lastError: 'gateway reconnect drift',
      steps: [
        {
          kind: 'join',
          operationId: 'op-rejoin-a',
          channelId: 'voice-a',
          reason: 'rejoin',
        },
      ],
    })
  })

  it('ignores step failures for stale operations', () => {
    const joining = reduceDirector(
      createInitialDirectorState(),
      { type: 'intent', channelId: 'voice-a', reason: 'manual_join' },
      operationIds('op-join-a'),
    )

    const next = reduceDirector(
      joining,
      { type: 'step_failed', operationId: 'op-stale', error: 'timeout' },
      operationIds('op-unused'),
    )

    expect(next).toBe(joining)
  })

  it('replans the desired channel when a committed session disconnects unexpectedly', () => {
    const state = committedState('voice-a')

    const next = reduceDirector(
      state,
      {
        type: 'disconnected',
        operationId: null,
        expected: false,
        error: 'Room disconnected',
      },
      operationIds('op-rejoin-a'),
    )

    expect(next).toMatchObject({
      desired: { kind: 'channel', channelId: 'voice-a' },
      committed: null,
      phase: 'joining',
      activeOperationId: 'op-rejoin-a',
      lastError: 'Room disconnected',
      steps: [
        {
          kind: 'join',
          operationId: 'op-rejoin-a',
          channelId: 'voice-a',
          reason: 'rejoin',
        },
      ],
    })
  })

  it('keeps committed state when a connected room disconnect is expected', () => {
    const state = committedState('voice-a')

    const next = reduceDirector(
      state,
      { type: 'disconnected', operationId: null, expected: true },
      operationIds('op-unused'),
    )

    expect(next).toBe(state)
  })

  it('resets to the initial state', () => {
    const joining = reduceDirector(
      createInitialDirectorState(),
      { type: 'intent', channelId: 'voice-a', reason: 'manual_join' },
      operationIds('op-join-a'),
    )

    const reset = reduceDirector(joining, { type: 'reset' }, operationIds())

    expect(reset).toEqual(createInitialDirectorState())
  })
})
