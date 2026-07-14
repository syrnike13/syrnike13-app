import type { SoundEventId } from '#/features/sounds/sound-events'
import { baseVoiceIdentity } from '#/features/voice/native-voice-identity'

export const SCREEN_VIEWER_SOUND_TOPIC = 'syrnike13.screen-viewer-sound'

type ScreenViewerSoundAction = 'join' | 'leave'

export function screenViewerWatchNotification({
  isLocal,
  wasWatching,
  subscribed,
}: {
  isLocal: boolean
  wasWatching: boolean
  subscribed: boolean
}): ScreenViewerSoundAction | null {
  if (isLocal || wasWatching === subscribed) return null
  return subscribed ? 'join' : 'leave'
}

type ScreenViewerSoundPayload = {
  type: 'screen_viewer'
  action: ScreenViewerSoundAction
  screenOwnerId: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function createScreenViewerSoundPayload({
  action,
  screenOwnerId,
}: {
  action: ScreenViewerSoundAction
  screenOwnerId: string
}) {
  const payload: ScreenViewerSoundPayload = {
    type: 'screen_viewer',
    action,
    screenOwnerId,
  }
  return encoder.encode(JSON.stringify(payload))
}

function parseScreenViewerSoundPayload(
  payload: Uint8Array,
): ScreenViewerSoundPayload | null {
  try {
    const parsed = JSON.parse(decoder.decode(payload)) as Partial<ScreenViewerSoundPayload>
    if (parsed.type !== 'screen_viewer') return null
    if (parsed.action !== 'join' && parsed.action !== 'leave') return null
    if (typeof parsed.screenOwnerId !== 'string' || !parsed.screenOwnerId) {
      return null
    }
    return {
      type: parsed.type,
      action: parsed.action,
      screenOwnerId: parsed.screenOwnerId,
    }
  } catch {
    return null
  }
}

export function screenViewerSoundEventFromData({
  payload,
  topic,
  senderIdentity,
  currentUserId,
}: {
  payload: Uint8Array
  topic?: string
  senderIdentity?: string
  currentUserId?: string | null
}): SoundEventId | null {
  if (topic !== SCREEN_VIEWER_SOUND_TOPIC) return null
  if (!senderIdentity || !currentUserId) return null

  const senderUserId = baseVoiceIdentity(senderIdentity)
  if (senderUserId === currentUserId) return null

  const parsed = parseScreenViewerSoundPayload(payload)
  if (!parsed || parsed.screenOwnerId !== currentUserId) return null

  return parsed.action === 'join'
    ? 'screen_share.viewer_join'
    : 'screen_share.viewer_leave'
}
