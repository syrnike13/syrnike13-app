import { describe, expect, it } from 'vitest'

import {
  createInitialVoiceSessionState,
  reduceVoiceSession,
} from './voice-session-machine'

describe('voice session machine', () => {
  it('keeps the target channel as desired state when a handoff connect fails', () => {
    let state = createInitialVoiceSessionState()

    state = reduceVoiceSession(state, {
      type: 'join_requested',
      channelId: 'voice-a',
      operationId: 'op-a',
      reason: 'manual_join',
    })
    state = reduceVoiceSession(state, {
      type: 'server_prepare_succeeded',
      operationId: 'op-a',
    })
    state = reduceVoiceSession(state, {
      type: 'room_connected',
      operationId: 'op-a',
    })
    state = reduceVoiceSession(state, {
      type: 'server_commit_observed',
      operationId: 'op-a',
      channelId: 'voice-a',
    })
    state = reduceVoiceSession(state, {
      type: 'join_requested',
      channelId: 'voice-b',
      operationId: 'op-b',
      reason: 'switch',
    })
    state = reduceVoiceSession(state, {
      type: 'room_connect_failed',
      operationId: 'op-b',
      error: 'LiveKit timeout',
    })

    expect(state.desired).toEqual({
      kind: 'channel',
      channelId: 'voice-b',
      operationId: 'op-b',
      reason: 'switch',
    })
    expect(state.phase).toBe('failed_retrying')
    expect(state.connectedChannelId).toBe('voice-a')
    expect(state.lastError).toBe('LiveKit timeout')
  })

  it('clears desired channel when an initial direct message call connect fails', () => {
    let state = createInitialVoiceSessionState()

    state = reduceVoiceSession(state, {
      type: 'join_requested',
      channelId: 'dm-channel',
      operationId: 'op-dm',
      reason: 'dm_answer',
    })
    state = reduceVoiceSession(state, {
      type: 'room_connect_failed',
      operationId: 'op-dm',
      error: 'Voice join rejected',
    })

    expect(state.desired).toEqual({ kind: 'none', operationId: null })
    expect(state.phase).toBe('idle')
    expect(state.connectedChannelId).toBeNull()
    expect(state.activeOperationId).toBeNull()
    expect(state.previousChannelId).toBeNull()
    expect(state.lastError).toBe('Voice join rejected')
  })

  it('lets the latest operation ignore stale success and failure events', () => {
    let state = createInitialVoiceSessionState()

    state = reduceVoiceSession(state, {
      type: 'join_requested',
      channelId: 'voice-a',
      operationId: 'op-a',
      reason: 'manual_join',
    })
    state = reduceVoiceSession(state, {
      type: 'join_requested',
      channelId: 'voice-b',
      operationId: 'op-b',
      reason: 'switch',
    })
    state = reduceVoiceSession(state, {
      type: 'server_prepare_succeeded',
      operationId: 'op-a',
    })
    state = reduceVoiceSession(state, {
      type: 'room_connect_failed',
      operationId: 'op-a',
      error: 'old operation failed',
    })

    expect(state.desired).toEqual({
      kind: 'channel',
      channelId: 'voice-b',
      operationId: 'op-b',
      reason: 'switch',
    })
    expect(state.phase).toBe('preparing')
    expect(state.lastError).toBeNull()
  })

  it('turns unexpected disconnects into reconnecting desired channel state', () => {
    let state = createInitialVoiceSessionState()

    state = reduceVoiceSession(state, {
      type: 'join_requested',
      channelId: 'voice-a',
      operationId: 'op-a',
      reason: 'manual_join',
    })
    state = reduceVoiceSession(state, {
      type: 'server_commit_observed',
      operationId: 'op-a',
      channelId: 'voice-a',
    })
    state = reduceVoiceSession(state, {
      type: 'room_disconnected',
      expected: false,
      operationId: 'op-a',
      error: 'network lost',
    })

    expect(state.phase).toBe('reconnecting')
    expect(state.desired.kind).toBe('channel')
    expect(state.connectedChannelId).toBeNull()
    expect(state.lastError).toBe('network lost')
  })

  it('clears stale intent fields after an expected disconnect', () => {
    let state = createInitialVoiceSessionState()

    state = reduceVoiceSession(state, {
      type: 'join_requested',
      channelId: 'voice-a',
      operationId: 'op-a',
      reason: 'manual_join',
    })
    state = reduceVoiceSession(state, {
      type: 'server_commit_observed',
      operationId: 'op-a',
      channelId: 'voice-a',
    })
    state = reduceVoiceSession(state, {
      type: 'join_requested',
      channelId: 'voice-b',
      operationId: 'op-b',
      reason: 'switch',
    })
    state = reduceVoiceSession(state, {
      type: 'room_disconnected',
      expected: true,
      operationId: 'op-b',
    })

    expect(state.phase).toBe('idle')
    expect(state.desired).toEqual({ kind: 'none', operationId: null })
    expect(state.connectedChannelId).toBeNull()
    expect(state.activeOperationId).toBeNull()
    expect(state.previousChannelId).toBeNull()
  })

  it('explicit leave cancels desired channel and stale joins cannot reconnect it', () => {
    let state = createInitialVoiceSessionState()

    state = reduceVoiceSession(state, {
      type: 'join_requested',
      channelId: 'voice-a',
      operationId: 'op-a',
      reason: 'manual_join',
    })
    state = reduceVoiceSession(state, {
      type: 'leave_requested',
      operationId: 'op-leave',
    })
    state = reduceVoiceSession(state, {
      type: 'server_commit_observed',
      operationId: 'op-a',
      channelId: 'voice-a',
    })

    expect(state.desired).toEqual({ kind: 'none', operationId: 'op-leave' })
    expect(state.phase).toBe('leaving')
    expect(state.connectedChannelId).toBeNull()
  })

  it('does not become connected from native publish before server commit', () => {
    let state = createInitialVoiceSessionState()

    state = reduceVoiceSession(state, {
      type: 'join_requested',
      channelId: 'voice-a',
      operationId: 'op-a',
      reason: 'manual_join',
    })
    state = reduceVoiceSession(state, {
      type: 'server_prepare_succeeded',
      operationId: 'op-a',
    })
    state = reduceVoiceSession(state, {
      type: 'room_connected',
      operationId: 'op-a',
    })
    state = reduceVoiceSession(state, {
      type: 'native_publish_succeeded',
      operationId: 'op-a',
    })

    expect(state.phase).toBe('waiting_server_commit')
    expect(state.connectedChannelId).toBeNull()
  })
})
