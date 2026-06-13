import { describe, expect, it, vi } from 'vitest'

import {
  voiceCommitFromGatewayEvent,
  voiceCommitOperationIdToObserve,
} from './voice-session-events'

describe('voice session gateway events', () => {
  it('returns the committed channel when the local user joins voice', () => {
    const commit = voiceCommitFromGatewayEvent(
      {
        type: 'VoiceChannelJoin',
        id: 'voice-a',
        operation_id: 'op-join',
        state: { id: 'user-a' },
      },
      'user-a',
    )

    expect(commit).toEqual({ channelId: 'voice-a', operationId: 'op-join' })
  })

  it('returns the target channel when the local user moves voice channels', () => {
    const commit = voiceCommitFromGatewayEvent(
      {
        type: 'VoiceChannelMove',
        user: 'user-a',
        from: 'voice-a',
        to: 'voice-b',
        operation_id: 'op-move',
        state: { id: 'user-a' },
      },
      'user-a',
    )

    expect(commit).toEqual({ channelId: 'voice-b', operationId: 'op-move' })
  })

  it('observes server commits only for the current desired operation', () => {
    const handleServerCommitObserved = vi.fn()
    const state = {
      activeOperationId: 'op-join',
      desired: {
        kind: 'channel' as const,
        channelId: 'voice-a',
        operationId: 'op-join',
        reason: 'manual_join' as const,
      },
    }

    const operationId = voiceCommitOperationIdToObserve(state, {
      channelId: 'voice-a',
      operationId: 'op-join',
    })
    if (operationId) handleServerCommitObserved(operationId, 'voice-a')

    expect(handleServerCommitObserved).toHaveBeenCalledTimes(1)
    expect(handleServerCommitObserved).toHaveBeenCalledWith(
      'op-join',
      'voice-a',
    )
  })

  it('ignores stale server commits for a different operation', () => {
    const handleServerCommitObserved = vi.fn()
    const state = {
      activeOperationId: 'op-join',
      desired: {
        kind: 'channel' as const,
        channelId: 'voice-a',
        operationId: 'op-join',
        reason: 'manual_join' as const,
      },
    }

    const operationId = voiceCommitOperationIdToObserve(state, {
      channelId: 'voice-a',
      operationId: 'op-stale',
    })
    if (operationId) handleServerCommitObserved(operationId, 'voice-a')

    expect(handleServerCommitObserved).not.toHaveBeenCalled()
  })

  it('ignores voice commits for other users', () => {
    expect(
      voiceCommitFromGatewayEvent(
        {
          type: 'VoiceChannelJoin',
          id: 'voice-a',
          state: { id: 'user-b' },
        },
        'user-a',
      ),
    ).toBeNull()

    expect(
      voiceCommitFromGatewayEvent(
        {
          type: 'VoiceChannelMove',
          user: 'user-b',
          from: 'voice-a',
          to: 'voice-b',
          state: { id: 'user-b' },
        },
        'user-a',
      ),
    ).toBeNull()
  })
})
