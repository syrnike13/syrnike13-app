import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { voiceCommitFromGatewayEvent } from './voice-session-events'

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

  it('requires provider server commits to use the gateway operation id', () => {
    const source = readFileSync(
      new URL('./voice-provider.tsx', import.meta.url),
      'utf8',
    )
    const commitEffect = source.match(
      /const commit = voiceCommitFromGatewayEvent[\s\S]*?controller\.handleServerCommitObserved\([\s\S]*?\)/,
    )?.[0]

    expect(commitEffect).toBeDefined()
    expect(commitEffect).toContain('!commit.operationId')
    expect(commitEffect).toContain('state.desired.operationId !== commit.operationId')
    expect(commitEffect).toContain('commit.operationId')
    expect(commitEffect).not.toContain('state.activeOperationId,\n        commit.channelId')
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
