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
    committedOperationId: `op-committed-${channelId}`,
    controlOperationId: `op-committed-${channelId}`,
    phase: 'connected',
    steps: [],
    activeOperationId: null,
    operationJournal: [
      {
        operationId: `op-committed-${channelId}`,
        channelId,
        kind: 'join',
        expectedCurrentOperationId: null,
        gatewayDispatched: true,
        authority: 'accepted',
        lifecycle: 'committed',
      },
    ],
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
          expectedCurrentOperationId: 'op-committed-voice-a',
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
        gatewayDispatched: false,
        expectedCurrentOperationId: 'op-committed-voice-a',
      },
    ])
    expect(movingToC.operationJournal).toContainEqual(
      expect.objectContaining({
        operationId: 'op-join-b',
        lifecycle: 'superseded',
      }),
    )
  })

  it('chains a superseding join from the last server-accepted operation', () => {
    const movingToB = reduceDirector(
      committedState('voice-a'),
      { type: 'intent', channelId: 'voice-b', reason: 'switch' },
      operationIds('op-join-b'),
    )
    const dispatchedToB = reduceDirector(
      movingToB,
      { type: 'gateway_dispatched', operationId: 'op-join-b' },
      operationIds('op-unused'),
    )
    const acceptedToB = reduceDirector(
      dispatchedToB,
      { type: 'gateway_accepted', operationId: 'op-join-b' },
      operationIds('op-unused'),
    )

    const movingToC = reduceDirector(
      acceptedToB,
      { type: 'intent', channelId: 'voice-c', reason: 'switch' },
      operationIds('op-join-c'),
    )

    expect(movingToC.steps).toEqual([{
      kind: 'join',
      operationId: 'op-join-c',
      channelId: 'voice-c',
      reason: 'switch',
      gatewayDispatched: false,
      expectedCurrentOperationId: 'op-join-b',
    }])
  })

  it('chains an idle supersede from the accepted prepared operation', () => {
    const joiningA = reduceDirector(
      createInitialDirectorState(),
      { type: 'intent', channelId: 'voice-a', reason: 'manual_join' },
      operationIds('op-join-a'),
    )
    const dispatchedA = reduceDirector(
      joiningA,
      { type: 'gateway_dispatched', operationId: 'op-join-a' },
      operationIds('op-unused'),
    )
    const acceptedA = reduceDirector(
      dispatchedA,
      { type: 'gateway_accepted', operationId: 'op-join-a' },
      operationIds('op-unused'),
    )

    const joiningB = reduceDirector(
      acceptedA,
      { type: 'intent', channelId: 'voice-b', reason: 'switch' },
      operationIds('op-join-b'),
    )

    expect(joiningB.steps[0]).toMatchObject({
      operationId: 'op-join-b',
      expectedCurrentOperationId: 'op-join-a',
    })
  })

  it('rewrites a queued successor only after the superseded request is accepted', () => {
    const movingToB = reduceDirector(
      committedState('voice-a'),
      { type: 'intent', channelId: 'voice-b', reason: 'switch' },
      operationIds('op-join-b'),
    )
    const dispatchedB = reduceDirector(
      movingToB,
      { type: 'gateway_dispatched', operationId: 'op-join-b' },
      operationIds('op-unused'),
    )
    const movingToC = reduceDirector(
      dispatchedB,
      { type: 'intent', channelId: 'voice-c', reason: 'switch' },
      operationIds('op-join-c'),
    )
    expect(movingToC.steps[0]).toMatchObject({
      operationId: 'op-join-c',
      expectedCurrentOperationId: 'op-committed-voice-a',
    })

    const acceptedB = reduceDirector(
      movingToC,
      { type: 'gateway_accepted', operationId: 'op-join-b' },
      operationIds('op-unused'),
    )
    expect(acceptedB.controlOperationId).toBe('op-join-b')
    expect(acceptedB.steps[0]).toMatchObject({
      operationId: 'op-join-c',
      expectedCurrentOperationId: 'op-join-b',
    })
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
        gatewayDispatched: false,
      },
    ])
    expect(joiningB.activeOperationId).toBe('op-join-b')
    expect(joiningB.operationJournal).toContainEqual(
      expect.objectContaining({
        operationId: 'op-join-a',
        lifecycle: 'superseded',
      }),
    )
  })

  it('records a late authoritative commit without replacing the newer prepared join', () => {
    const joiningA = reduceDirector(
      createInitialDirectorState(),
      { type: 'intent', channelId: 'voice-a', reason: 'manual_join' },
      operationIds('op-join-a'),
    )
    const dispatchedA = reduceDirector(
      joiningA,
      { type: 'gateway_dispatched', operationId: 'op-join-a' },
      operationIds('op-unused'),
    )
    const joiningB = reduceDirector(
      dispatchedA,
      { type: 'intent', channelId: 'voice-b', reason: 'switch' },
      operationIds('op-join-b'),
    )

    const observed = reduceDirector(
      joiningB,
      { type: 'commit', operationId: 'op-join-a', channelId: 'voice-a' },
      operationIds('op-unused'),
    )

    expect(observed.committed).toBe('voice-a')
    expect(observed.committedOperationId).toBe('op-join-a')
    expect(observed.steps).toEqual(joiningB.steps)
  })

  it('falls back to a fresh reconnect when the candidate commits before retain wins', () => {
    const movingToB = reduceDirector(
      committedState('voice-a'),
      { type: 'intent', channelId: 'voice-b', reason: 'switch' },
      operationIds('op-join-b'),
    )
    const dispatchedToB = reduceDirector(
      movingToB,
      { type: 'gateway_dispatched', operationId: 'op-join-b' },
      operationIds('op-unused'),
    )
    const retainingA = reduceDirector(
      dispatchedToB,
      {
        type: 'restore_source_after_dispatch',
        channelId: 'voice-a',
        retainedOperationId: 'op-committed-voice-a',
        expectedCurrentOperationId: 'op-join-b',
        reason: 'switch',
      },
      operationIds('op-unused'),
    )

    const reconnectingA = reduceDirector(
      retainingA,
      { type: 'commit', operationId: 'op-join-b', channelId: 'voice-b' },
      operationIds('op-return-a2'),
    )

    expect(reconnectingA).toMatchObject({
      committed: 'voice-b',
      committedOperationId: 'op-join-b',
      desired: { kind: 'channel', channelId: 'voice-a' },
      steps: [{
        kind: 'join',
        operationId: 'op-return-a2',
        channelId: 'voice-a',
        expectedCurrentOperationId: 'op-join-b',
      }],
    })
    expect(reconnectingA.steps[0]).not.toHaveProperty('retainFinalized')
  })

  it('replans after a late candidate commit even when retain already failed', () => {
    const movingToB = reduceDirector(
      committedState('voice-a'),
      { type: 'intent', channelId: 'voice-b', reason: 'switch' },
      operationIds('op-join-b'),
    )
    const dispatchedToB = reduceDirector(
      movingToB,
      { type: 'gateway_dispatched', operationId: 'op-join-b' },
      operationIds('op-unused'),
    )
    const retainingA = reduceDirector(
      dispatchedToB,
      {
        type: 'restore_source_after_dispatch',
        channelId: 'voice-a',
        retainedOperationId: 'op-committed-voice-a',
        expectedCurrentOperationId: 'op-join-b',
        reason: 'switch',
      },
      operationIds('op-unused'),
    )
    const failedRetain = reduceDirector(
      retainingA,
      {
        type: 'step_failed',
        operationId: 'op-committed-voice-a',
        error: 'retain conflict',
      },
      operationIds('op-unused'),
    )
    expect(failedRetain.steps).toEqual([])

    const reconnectingA = reduceDirector(
      failedRetain,
      { type: 'commit', operationId: 'op-join-b', channelId: 'voice-b' },
      operationIds('op-return-a2'),
    )
    expect(reconnectingA.steps[0]).toMatchObject({
      operationId: 'op-return-a2',
      channelId: 'voice-a',
      expectedCurrentOperationId: 'op-join-b',
    })
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

  it('keeps desired without entering an automatic retry loop when a step fails', () => {
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
      phase: 'idle',
      activeOperationId: null,
      lastError: 'timeout',
      steps: [],
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

  it('rejoins only after an exact operation-fenced committed leave', () => {
    const state = committedState('voice-a')

    const mismatch = reduceDirector(
      state,
      { type: 'leave_observed', operationId: 'op-other' },
      operationIds('op-unused'),
    )
    expect(mismatch).toBe(state)

    const left = reduceDirector(
      state,
      {
        type: 'leave_observed',
        operationId: 'op-committed-voice-a',
      },
      operationIds('op-rejoin-a'),
    )
    expect(left).toMatchObject({
      committed: null,
      committedOperationId: null,
      controlOperationId: null,
      desired: { kind: 'channel', channelId: 'voice-a' },
      activeOperationId: 'op-rejoin-a',
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

  it('bounds the operation journal while preserving current authority', () => {
    let state = committedState('voice-a')
    let sequence = 0
    const createOperationId = () => `op-switch-${sequence++}`

    for (let index = 0; index < 100; index += 1) {
      state = reduceDirector(
        state,
        {
          type: 'intent',
          channelId: index % 2 === 0 ? 'voice-b' : 'voice-c',
          reason: 'switch',
        },
        createOperationId,
      )
    }

    expect(state.operationJournal.length).toBeLessThanOrEqual(32)
    expect(state.operationJournal).toContainEqual(
      expect.objectContaining({
        operationId: 'op-committed-voice-a',
        lifecycle: 'committed',
      }),
    )
    expect(state.operationJournal).toContainEqual(
      expect.objectContaining({
        operationId: state.activeOperationId,
        lifecycle: 'active',
      }),
    )
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
