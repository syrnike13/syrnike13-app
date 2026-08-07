import { Option, Schema } from 'effect'

import type { SoundEventId } from '#/features/sounds/sound-events'
import { baseVoiceIdentity } from '#/features/voice/native-voice-identity'

export const SCREEN_VIEWER_SOUND_TOPIC = 'syrnike13.screen-viewer-sound'

const ScreenViewerSoundActionSchema = Schema.Literals(['join', 'leave'])
type ScreenViewerSoundAction = typeof ScreenViewerSoundActionSchema.Type

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

const ScreenViewerSoundPayloadSchema = Schema.Struct({
  type: Schema.Literal('screen_viewer'),
  action: ScreenViewerSoundActionSchema,
  screenOwnerId: Schema.String.check(Schema.isMinLength(1)),
})

const ScreenViewerSoundPayloadJsonSchema = Schema.fromJsonString(
  ScreenViewerSoundPayloadSchema,
)

type ScreenViewerSoundPayload = typeof ScreenViewerSoundPayloadSchema.Type

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
  return encoder.encode(
    Schema.encodeSync(ScreenViewerSoundPayloadJsonSchema)(payload),
  )
}

function parseScreenViewerSoundPayload(
  payload: Uint8Array,
): ScreenViewerSoundPayload | null {
  return Option.getOrNull(
    Schema.decodeUnknownOption(ScreenViewerSoundPayloadJsonSchema)(
      decoder.decode(payload),
    ),
  )
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
