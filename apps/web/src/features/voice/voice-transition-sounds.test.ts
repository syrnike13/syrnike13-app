import { createInactiveMediaSnapshot, type VoiceSnapshot } from '@syrnike13/platform'
import { describe, expect, it } from 'vitest'

import { voiceSnapshotTransitionSounds } from './voice-transition-sounds'

describe('voiceSnapshotTransitionSounds', () => {
  it('plays the self join sound only when a snapshot becomes connected', () => {
    const disconnected = snapshot()
    const connected = snapshot({ connection: 'connected' })

    expect(voiceSnapshotTransitionSounds(disconnected, connected)).toEqual([
      'voice.user_join',
    ])
    expect(voiceSnapshotTransitionSounds(connected, connected)).toEqual([])
  })

  it('plays screen sounds only for confirmed running and terminal transitions', () => {
    const starting = snapshot({ screenState: 'starting' })
    const running = snapshot({ screenState: 'running' })

    expect(voiceSnapshotTransitionSounds(snapshot(), starting)).toEqual([])
    expect(voiceSnapshotTransitionSounds(starting, running)).toEqual([
      'screen_share.started',
    ])
    expect(
      voiceSnapshotTransitionSounds(running, snapshot({ screenState: 'starting' })),
    ).toEqual([])
    expect(voiceSnapshotTransitionSounds(running, snapshot())).toEqual([
      'screen_share.stopped',
    ])
    expect(
      voiceSnapshotTransitionSounds(running, snapshot({ screenState: 'failed' })),
    ).toEqual(['screen_share.stopped'])
  })

  it('keeps the same confirmed transition policy for future camera sounds', () => {
    const running = snapshot({ cameraState: 'running' })

    expect(voiceSnapshotTransitionSounds(snapshot(), running)).toEqual([
      'camera.started',
    ])
    expect(voiceSnapshotTransitionSounds(running, snapshot())).toEqual([
      'camera.stopped',
    ])
  })
})

function snapshot({
  connection = 'disconnected',
  screenState = 'off',
  cameraState = 'off',
}: {
  connection?: VoiceSnapshot['connection']
  screenState?: VoiceSnapshot['screen']['state']
  cameraState?: VoiceSnapshot['camera']['state']
} = {}): VoiceSnapshot {
  return {
    intentChannelId: null,
    membershipChannelId: connection === 'connected' ? 'voice-1' : null,
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
