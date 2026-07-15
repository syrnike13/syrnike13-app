import type { VoiceMediaState, VoiceSnapshot } from '@syrnike13/platform'

import type { SoundEventId } from '#/features/sounds/sound-events'

export function voiceSnapshotTransitionSounds(
  previous: VoiceSnapshot,
  current: VoiceSnapshot,
): SoundEventId[] {
  const sounds: SoundEventId[] = []
  const previousChannelId = previous.membershipChannelId
  const currentChannelId = current.membershipChannelId
  const joinedChannel =
    current.connection === 'connected' &&
    currentChannelId != null &&
    currentChannelId !== previousChannelId
  const stayedConnected =
    previous.connection === 'connected' &&
    current.connection === 'connected' &&
    previousChannelId != null &&
    previousChannelId === currentChannelId
  const leftChannel =
    previousChannelId != null &&
    currentChannelId == null &&
    (current.connection === 'disconnected' || current.connection === 'failed')

  if (joinedChannel) {
    sounds.push('voice.user_join')
  }

  if (stayedConnected) {
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
  }

  if (leftChannel) sounds.push('voice.disconnect')

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
