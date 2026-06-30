import { useAuth } from '#/features/auth/auth-context'
import {
  getChannelVoiceParticipants,
  useChannelVoiceParticipantsWithLocalOverride,
} from '#/features/sync/voice-selectors'
import { memberRoleEntries } from '#/features/sync/selectors'
import { useSyncStore } from '#/features/sync/sync-store'
import { useVoiceSession } from '#/features/voice/voice-session-context'
import { isVoiceSessionInChannel } from '#/features/voice/voice-mic-status'
import { VoiceParticipantRow } from '#/components/voice/voice-participant-row'
import { voiceParticipantDisplayName } from '#/features/voice/voice-participant-label'
import { isVoiceLocalUserId } from '#/features/voice/voice-connecting-preview'
import { serverChannelServerId } from '#/lib/channel-voice'
/** Начало аватарки = начало названия канала: px-2 + icon 16px + gap-2 − px-2 строки */
const VOICE_PREVIEW_TEXT_INSET = 'pl-6' as const

type VoiceChannelPreviewProps = {
  channelId: string
}

export function VoiceChannelPreview({ channelId }: VoiceChannelPreviewProps) {
  const auth = useAuth()
  const voice = useVoiceSession()
  const users = useSyncStore((s) => s.users)
  const channel = useSyncStore((s) => s.channels[channelId])
  const serverId = serverChannelServerId(channel)
  const server = useSyncStore((s) =>
    serverId ? s.servers[serverId] : undefined,
  )
  const members = useSyncStore((s) => s.members)
  const storeParticipants = useSyncStore((s) =>
    getChannelVoiceParticipants(s, channelId, auth.user?._id),
  )
  const inThisChannel = isVoiceSessionInChannel(voice, channelId)
  const connecting =
    voice.status === 'connecting' && inThisChannel
  const participants = useChannelVoiceParticipantsWithLocalOverride(
    channelId,
    storeParticipants,
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
        const isSelf = isVoiceLocalUserId(participant.id, auth.user?._id)
        const user = users[participant.id] ?? (isSelf ? auth.user ?? undefined : undefined)
        const voiceElsewhere = isSelf && !inThisChannel
        const member =
          serverId && user
            ? members[`${serverId}:${user._id}`]
            : undefined

        return (
          <VoiceParticipantRow
            key={participant.id}
            channelId={channelId}
            participant={participant}
            user={user}
            displayName={voiceParticipantDisplayName(
              participant.id,
              users,
              auth.user,
            )}
            dimmed={connecting && isSelf}
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
