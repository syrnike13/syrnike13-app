import { describe, expect, it } from 'vitest'
import { createTranslator } from '@syrnike13/ui/i18n'

import ru from '#/messages/ru.json'
import {
  buildVoiceStageViewSessions,
  voiceStageViewSessionExitLabel,
} from './voice-stage-view-session'

const t = createTranslator(ru, 'ru', 'voice')

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
    expect(voiceStageViewSessionExitLabel(sessions[0], t)).toBe(
      'Прекратить просмотр — ALICE',
    )
    expect(voiceStageViewSessionExitLabel(sessions[2], t)).toBe(
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
