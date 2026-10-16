import type { VoiceMediaState, VoiceSnapshot } from '@syrnike13/platform'

import type { SoundEventId } from '#/features/sounds/sound-events'

/**
 * Был ли стрим/камера уже «в эфире» до перезапуска. Смена разрешения или FPS
 * проводит медиа через `running → starting → running`; это не новый старт.
 */
export type VoiceMediaLiveness = { screen: boolean; camera: boolean }

export function createVoiceMediaLiveness(
  snapshot: VoiceSnapshot,
): VoiceMediaLiveness {
  return {
    screen: snapshot.screen.state === 'running',
    camera: snapshot.camera.state === 'running',
  }
}

export function voiceSnapshotTransitionSounds(
  previous: VoiceSnapshot,
  current: VoiceSnapshot,
  liveness?: VoiceMediaLiveness,
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
      liveness,
      'screen',
    )
    appendMediaTransitionSounds(
      sounds,
      previous.camera.state,
      current.camera.state,
      'camera.started',
      'camera.stopped',
      liveness,
      'camera',
    )
  } else if (liveness) {
    liveness.screen = current.screen.state === 'running'
    liveness.camera = current.camera.state === 'running'
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
  liveness?: VoiceMediaLiveness,
  kind?: keyof VoiceMediaLiveness,
) {
  const wasLive = liveness && kind ? liveness[kind] : previous === 'running'
  if (current === 'running') {
    if (previous !== 'running' && !wasLive) sounds.push(started)
    if (liveness && kind) liveness[kind] = true
  } else if (isTerminalMediaState(current)) {
    if (previous === 'running' || wasLive) sounds.push(stopped)
    if (liveness && kind) liveness[kind] = false
  }
}

function isTerminalMediaState(state: VoiceMediaState) {
  return state === 'off' || state === 'failed'
}
