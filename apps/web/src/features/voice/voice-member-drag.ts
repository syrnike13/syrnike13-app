export const VOICE_MEMBER_DRAG_TYPE = 'application/x-syrnike-voice-member'

export type VoiceMemberDragPayload = {
  serverId: string
  channelId: string
  userId: string
}

export function writeVoiceMemberDragPayload(
  dataTransfer: DataTransfer,
  payload: VoiceMemberDragPayload,
) {
  dataTransfer.effectAllowed = 'move'
  dataTransfer.setData(VOICE_MEMBER_DRAG_TYPE, JSON.stringify(payload))
}

export function readVoiceMemberDragPayload(
  dataTransfer: DataTransfer,
): VoiceMemberDragPayload | null {
  try {
    const parsed = JSON.parse(
      dataTransfer.getData(VOICE_MEMBER_DRAG_TYPE),
    ) as Partial<VoiceMemberDragPayload>
    if (
      typeof parsed.serverId !== 'string' ||
      typeof parsed.channelId !== 'string' ||
      typeof parsed.userId !== 'string'
    ) {
      return null
    }
    return parsed as VoiceMemberDragPayload
  } catch {
    return null
  }
}
