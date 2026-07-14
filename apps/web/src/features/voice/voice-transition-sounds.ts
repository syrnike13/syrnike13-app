import type { VoiceMediaState, VoiceSnapshot } from '@syrnike13/platform'

import type { SoundEventId } from '#/features/sounds/sound-events'

export function voiceSnapshotTransitionSounds(
  previous: VoiceSnapshot,
  current: VoiceSnapshot,
): SoundEventId[] {
  const sounds: SoundEventId[] = []

  if (previous.connection !== 'connected' && current.connection === 'connected') {
    sounds.push('voice.user_join')
  }

  appendMediaTransitionSounds(
    sounds,
    previous.screen.state,
    current.screen.state,
    'screen_share.started',
    'screen_share.stopped',
  )
  appendMediaTransitionSounds(
    sounds,
    previous.camera.state,
    current.camera.state,
    'camera.started',
    'camera.stopped',
  )

  return sounds
}

function appendMediaTransitionSounds(
  sounds: SoundEventId[],
  previous: VoiceMediaState,
  current: VoiceMediaState,
  started: SoundEventId,
  stopped: SoundEventId,
) {
  if (previous !== 'running' && current === 'running') {
    sounds.push(started)
  } else if (previous === 'running' && isTerminalMediaState(current)) {
    sounds.push(stopped)
  }
}

function isTerminalMediaState(state: VoiceMediaState) {
  return state === 'off' || state === 'failed'
}
