import { useTranslations } from '@syrnike13/ui/i18n'

import { useAuth } from '#/features/auth/auth-context'
import {
  getChannelVoiceParticipants,
  sameVoiceParticipantList,
  useChannelVoiceParticipantsWithLocalOverride,
} from '#/features/sync/voice-selectors'
import { memberRoleEntries } from '@syrnike13/client/sync/selectors'
import { useSyncStore } from '@syrnike13/client/sync/sync-store'
import { useVoiceSession } from '#/features/voice/voice-session-context'
import { isVoiceSessionInChannel } from '#/features/voice/voice-mic-status'
import { VoiceParticipantRow } from '#/components/voice/voice-participant-row'
import { voiceParticipantDisplayName } from '#/features/voice/voice-participant-label'
import { isVoiceLocalUserId } from '#/features/voice/voice-connecting-preview'
import { serverChannelServerId } from '@syrnike13/client/lib/channel-voice'
import { ActivityApplicationIcon } from '#/features/activities/activity-application-icon'
import {
  useActivityApplication,
  useActivityInstance,
} from '#/features/activities/use-activities'
/** Начало аватарки = начало названия канала: px-2 + icon 16px + gap-2 − px-2 строки */
const VOICE_PREVIEW_TEXT_INSET = 'pl-6' as const

type VoiceChannelPreviewProps = {
  channelId: string
}

export function VoiceChannelPreview({ channelId }: VoiceChannelPreviewProps) {
  const t = useTranslations('voice')
  const tA = useTranslations('activities')
  const auth = useAuth()
  const voice = useVoiceSession()
  const users = useSyncStore((s) => s.users)
  const channel = useSyncStore((s) => s.channels[channelId])
  const serverId = serverChannelServerId(channel)
  const server = useSyncStore((s) =>
    serverId ? s.servers[serverId] : undefined,
  )
  const members = useSyncStore((s) => s.members)
  const storeParticipants = useSyncStore(
    (s) => getChannelVoiceParticipants(s, channelId, auth.user?._id),
    sameVoiceParticipantList,
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

  const activityInstance = useActivityInstance(channelId)
  const activityApplication = useActivityApplication(
    activityInstance?.application_id,
  )
  const activityParticipantIds = new Set(
    activityInstance?.participants.map((participant) => participant.user_id),
  )

  if (participants.length === 0) return null

  return (
    <div
      className={`mb-1 flex flex-col gap-0.5 ${VOICE_PREVIEW_TEXT_INSET}`}
    >
      {activityInstance ? (
        <div
          data-testid="voice-channel-activity"
          className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-xs"
        >
          <ActivityApplicationIcon
            application={activityApplication}
            className="size-6"
          />
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">
            {activityApplication?.name ?? tA('unknownApplication')}
          </span>
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {tA('sidebarParticipants', {
              count: activityInstance.participants.length,
            })}
          </span>
        </div>
      ) : null}
      {participants.map((participant) => {
        const isSelf = isVoiceLocalUserId(participant.id, auth.user?._id ?? null)
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
              t,
            )}
            dimmed={connecting && isSelf}
            voiceElsewhere={voiceElsewhere}
            speaking={
              inThisChannel && voice.speakingUserIds.has(participant.id)
            }
            compact
            inActivity={activityParticipantIds.has(participant.id)}
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
