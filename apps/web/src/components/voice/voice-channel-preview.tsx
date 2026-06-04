import { useAuth } from '#/features/auth/auth-context'
import {
  getChannelVoiceParticipants,
  useMergedChannelVoiceParticipants,
} from '#/features/sync/voice-selectors'
import { memberRoleEntries } from '#/features/sync/selectors'
import { useSyncStore } from '#/features/sync/sync-store'
import { useChannelVoiceState } from '#/features/voice/use-channel-voice-state'
import { useVoice } from '#/features/voice/voice-provider'
import { isVoiceSessionInChannel } from '#/features/voice/voice-mic-status'
import { VoiceParticipantRow } from '#/components/voice/voice-participant-row'

/** Совпадает с началом названия канала: px-3 + icon 16px + gap-2 */
const VOICE_PREVIEW_TEXT_INSET = 'pl-9' as const

type VoiceChannelPreviewProps = {
  channelId: string
}

function participantDisplayName(
  userId: string,
  users: Record<string, import('@syrnike13/api-types').User>,
  currentUserId?: string,
) {
  if (userId === currentUserId) return 'Вы'
  const user = users[userId]
  return user?.display_name ?? user?.username ?? 'Участник'
}

export function VoiceChannelPreview({ channelId }: VoiceChannelPreviewProps) {
  const auth = useAuth()
  const voice = useVoice()
  useChannelVoiceState(channelId)
  const users = useSyncStore((s) => s.users)
  const channel = useSyncStore((s) => s.channels[channelId])
  const serverId =
    channel?.channel_type === 'TextChannel' ||
    channel?.channel_type === 'VoiceChannel'
      ? channel.server
      : undefined
  const server = useSyncStore((s) =>
    serverId ? s.servers[serverId] : undefined,
  )
  const members = useSyncStore((s) => s.members)
  const storeParticipants = useSyncStore((s) =>
    getChannelVoiceParticipants(s, channelId, auth.user?._id),
  )
  const inThisChannel = isVoiceSessionInChannel(voice, channelId)
  const participants = useMergedChannelVoiceParticipants(
    channelId,
    storeParticipants,
    voice.liveChannelParticipants,
    inThisChannel,
    inThisChannel ? auth.user?._id : undefined,
    inThisChannel ? voice.micPublishing : undefined,
    inThisChannel ? voice.deafened : undefined,
  )

  if (participants.length === 0) return null

  return (
    <div
      className={`mb-1 flex flex-col gap-0.5 ${VOICE_PREVIEW_TEXT_INSET}`}
    >
      {participants.map((participant) => {
        const user = users[participant.id]
        const isSelf = participant.id === auth.user?._id
        const voiceElsewhere = isSelf && !inThisChannel
        const member =
          serverId && user
            ? members[`${serverId}:${user._id}`]
            : undefined

        return (
          <VoiceParticipantRow
            key={participant.id}
            participant={participant}
            user={user}
            displayName={participantDisplayName(
              participant.id,
              users,
              auth.user?._id,
            )}
            voiceElsewhere={voiceElsewhere}
            speaking={
              inThisChannel && voice.speakingUserIds.has(participant.id)
            }
            compact
            serverId={serverId}
            serverName={server?.name}
            roles={
              member ? memberRoleEntries(server, member) : undefined
            }
          />
        )
      })}
    </div>
  )
}
