import { createInactiveMediaSnapshot, type VoiceSnapshot } from '@syrnike13/platform'
import { describe, expect, it } from 'vitest'

import { voiceSnapshotTransitionSounds } from './voice-transition-sounds'

describe('voiceSnapshotTransitionSounds', () => {
  it('plays the self join sound only when a snapshot becomes connected', () => {
    const disconnected = snapshot()
    const connected = snapshot({ connection: 'connected' })
    const recovering = snapshot({
      connection: 'recovering',
      membershipChannelId: null,
    })

    expect(voiceSnapshotTransitionSounds(disconnected, connected)).toEqual([
      'voice.user_join',
    ])
    expect(voiceSnapshotTransitionSounds(connected, connected)).toEqual([])
    expect(voiceSnapshotTransitionSounds(recovering, connected)).toEqual([
      'voice.user_join',
    ])
  })

  it('plays screen sounds only for confirmed running and terminal transitions', () => {
    const connected = snapshot({ connection: 'connected' })
    const starting = snapshot({ connection: 'connected', screenState: 'starting' })
    const running = snapshot({ connection: 'connected', screenState: 'running' })

    expect(voiceSnapshotTransitionSounds(connected, starting)).toEqual([])
    expect(voiceSnapshotTransitionSounds(starting, running)).toEqual([
      'screen_share.started',
    ])
    expect(
      voiceSnapshotTransitionSounds(
        running,
        snapshot({ connection: 'connected', screenState: 'starting' }),
      ),
    ).toEqual([])
    expect(voiceSnapshotTransitionSounds(running, connected)).toEqual([
      'screen_share.stopped',
    ])
    expect(
      voiceSnapshotTransitionSounds(
        running,
        snapshot({ connection: 'connected', screenState: 'failed' }),
      ),
    ).toEqual(['screen_share.stopped'])
  })

  it('keeps the same confirmed transition policy for future camera sounds', () => {
    const connected = snapshot({ connection: 'connected' })
    const running = snapshot({ connection: 'connected', cameraState: 'running' })

    expect(voiceSnapshotTransitionSounds(connected, running)).toEqual([
      'camera.started',
    ])
    expect(voiceSnapshotTransitionSounds(running, connected)).toEqual([
      'camera.stopped',
    ])
  })

  it('plays disconnect only after membership is actually removed', () => {
    const connectedWithMedia = snapshot({
      connection: 'connected',
      screenState: 'running',
      cameraState: 'running',
    })

    expect(voiceSnapshotTransitionSounds(connectedWithMedia, snapshot())).toEqual([
      'voice.disconnect',
    ])
    expect(
      voiceSnapshotTransitionSounds(
        connectedWithMedia,
        snapshot({ connection: 'recovering' }),
      ),
    ).toEqual([])
  })
})

function snapshot({
  connection = 'disconnected',
  screenState = 'off',
  cameraState = 'off',
  membershipChannelId =
    connection === 'connected' || connection === 'recovering'
      ? 'voice-1'
      : null,
}: {
  connection?: VoiceSnapshot['connection']
  screenState?: VoiceSnapshot['screen']['state']
  cameraState?: VoiceSnapshot['camera']['state']
  membershipChannelId?: string | null
} = {}): VoiceSnapshot {
  return {
    intentChannelId: null,
    membershipChannelId,
    connection,
    microphone: createInactiveMediaSnapshot(),
    output: createInactiveMediaSnapshot(),
    camera: { state: cameraState },
    screen: { state: screenState },
    screenAudio: createInactiveMediaSnapshot(),
    userMuted: true,
    userDeafened: false,
    serverMuted: false,
    serverDeafened: false,
    systemPrivacyMuted: false,
    monitoringMuted: false,
    inputMode: 'voice_activity',
    pushToTalkHeld: false,
    effectiveMuted: true,
    speakingUserIds: [],
  }
}
