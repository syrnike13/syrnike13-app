import { Option, Schema } from 'effect'

export const VOICE_MEMBER_DRAG_TYPE = 'application/x-syrnike-voice-member'

const VoiceMemberDragPayloadSchema = Schema.Struct({
  serverId: Schema.String,
  channelId: Schema.String,
  userId: Schema.String,
})

const VoiceMemberDragPayloadJsonSchema = Schema.fromJsonString(
  VoiceMemberDragPayloadSchema,
)

export type VoiceMemberDragPayload = typeof VoiceMemberDragPayloadSchema.Type

export function writeVoiceMemberDragPayload(
  dataTransfer: DataTransfer,
  payload: VoiceMemberDragPayload,
) {
  dataTransfer.effectAllowed = 'move'
  dataTransfer.setData(
    VOICE_MEMBER_DRAG_TYPE,
    Schema.encodeSync(VoiceMemberDragPayloadJsonSchema)(payload),
  )
}

export function readVoiceMemberDragPayload(
  dataTransfer: DataTransfer,
): VoiceMemberDragPayload | null {
  return Option.getOrNull(
    Schema.decodeUnknownOption(VoiceMemberDragPayloadJsonSchema)(
    dataTransfer.getData(VOICE_MEMBER_DRAG_TYPE),
    ),
  )
}
