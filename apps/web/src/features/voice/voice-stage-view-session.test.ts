import { describe, expect, it } from 'vitest'

import {
  buildVoiceStageViewSessions,
  voiceStageViewSessionExitLabel,
} from './voice-stage-view-session'

describe('buildVoiceStageViewSessions', () => {
  it('combines watched streams and a joined Activity without duplicates', () => {
    const sessions = buildVoiceStageViewSessions({
      viewedRemoteScreenIds: [
        'alice:screen',
        'alice:screen',
        'bob:screen',
        'invalid',
      ],
      screenDisplayName: (userId) => userId.toUpperCase(),
      activity: {
        stageItemId: 'channel-activity:race-1',
        instanceId: 'race-1',
        channelId: 'voice-a',
        label: 'Сырниковая гонка',
        joined: true,
      },
    })

    expect(sessions).toEqual([
      {
        id: 'stream:alice:screen',
        stageItemId: 'alice:screen',
        kind: 'stream',
        label: 'ALICE',
      },
      {
        id: 'stream:bob:screen',
        stageItemId: 'bob:screen',
        kind: 'stream',
        label: 'BOB',
      },
      {
        id: 'activity:race-1',
        stageItemId: 'channel-activity:race-1',
        kind: 'activity',
        label: 'Сырниковая гонка',
        channelId: 'voice-a',
        instanceId: 'race-1',
      },
    ])
    expect(voiceStageViewSessionExitLabel(sessions[0])).toBe(
      'Прекратить просмотр — ALICE',
    )
    expect(voiceStageViewSessionExitLabel(sessions[2])).toBe(
      'Выйти из активности — Сырниковая гонка',
    )
  })

  it('does not expose an Activity before the current user joins it', () => {
    expect(
      buildVoiceStageViewSessions({
        viewedRemoteScreenIds: [],
        screenDisplayName: (userId) => userId,
        activity: {
          stageItemId: 'channel-activity:race-1',
          instanceId: 'race-1',
          channelId: 'voice-a',
          label: 'Сырниковая гонка',
          joined: false,
        },
      }),
    ).toEqual([])
  })
})
