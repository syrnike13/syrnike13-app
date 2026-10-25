import { useState } from 'react'
import type {
  Channel,
  DataMemberEdit,
  Member,
  Server,
} from '@syrnike13/api-types'
import { Effect } from 'effect'
import { useTranslations } from '@syrnike13/ui/i18n'

import {
  HeadphonesIcon,
  HeadphoneOffIcon,
  MicOffIcon,
  PhoneOffIcon,
} from '#/components/icons'
import {
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@syrnike13/ui/primitives/context-menu'
import { ContextMenuVolume } from '#/components/voice/context-menu-volume'
import { editServerMemberEffect } from '#/features/api/servers-api'
import { syncStore } from '#/features/sync/sync-store'
import {
  formatUserVolumeLabel,
  VOICE_USER_VOLUME_MAX,
  voiceListenerStore,
  useVoiceListenerStore,
} from '#/features/voice/voice-listener-store'
import { runtimeChannelName } from '#/lib/channel-voice'
import {
  canDeafenServerMember,
  canMoveServerMember,
  canMuteServerMember,
} from '#/features/authorization/authorization'

type UserContextMenuVoiceControlsProps = {
  userId: string
  token?: string
  server?: Server
  actorMember?: Member
  actorUserId?: string
  targetMember?: Member
  voiceChannelId?: string
  moveVoiceChannels?: Channel[]
}

type ServerVoiceAction = 'mute' | 'deafen' | 'disconnect' | 'move'

function isServerVoiceMoveTarget(channel: Channel): boolean {
  return channel.channel_type === 'TextChannel' && channel.voice != null
}

function canUseVoiceMoveTarget(channel: Channel) {
  return isServerVoiceMoveTarget(channel)
}

export function UserContextMenuVoiceControls({
  userId,
  token,
  server,
  actorMember,
  actorUserId,
  targetMember,
  voiceChannelId,
  moveVoiceChannels = [],
}: UserContextMenuVoiceControlsProps) {
  const t = useTranslations('users.voice')
  const isSelf = actorUserId === userId
  const volume = useVoiceListenerStore((s) => s.getUserVolume(userId))
  const muted = useVoiceListenerStore((s) => s.getUserMuted(userId))
  const [pendingAction, setPendingAction] = useState<ServerVoiceAction | null>(
    null,
  )
  const canServerMute =
    server &&
    canMuteServerMember(
      server,
      actorMember,
      actorUserId,
      targetMember,
    )
  const canServerDeafen =
    server &&
    canDeafenServerMember(
      server,
      actorMember,
      actorUserId,
      targetMember,
    )
  const canServerMove =
    server &&
    voiceChannelId &&
    canMoveServerMember(
      server,
      actorMember,
      actorUserId,
      targetMember,
    )
  const moveTargets =
    server && actorUserId
      ? moveVoiceChannels.filter((channel) => {
          if (channel._id === voiceChannelId) return false
          return canUseVoiceMoveTarget(channel)
        })
      : []
  const serverMuted = targetMember?.can_publish === false
  const serverDeafened = targetMember?.can_receive === false
  const showServerControls = Boolean(
    token &&
      server &&
      targetMember &&
      voiceChannelId &&
      (canServerMute || canServerDeafen || canServerMove),
  )

  if (isSelf && !showServerControls) return null

  async function editTargetMember(
    action: ServerVoiceAction,
    data: DataMemberEdit,
  ) {
    if (!token || !server || !targetMember || pendingAction) return

    setPendingAction(action)
    await Effect.runPromise(
      editServerMemberEffect(
        token,
        server._id,
        targetMember._id.user,
        data,
      ).pipe(
        Effect.tap((updated) =>
          Effect.sync(() => {
            const mayBeRemovedTemporaryMember =
              updated.temporary === true && (updated.roles?.length ?? 0) === 0
            const memberStillPresent =
              syncStore.getState().members[
                `${server._id}:${targetMember._id.user}`
              ] !== undefined
            if (!mayBeRemovedTemporaryMember || memberStillPresent) {
              syncStore.upsertMembers([updated])
            }
            if (data.remove?.includes('VoiceChannel') && voiceChannelId) {
              syncStore.removeVoiceParticipant(
                voiceChannelId,
                targetMember._id.user,
              )
            }
            if (data.voice_channel && voiceChannelId) {
              const participant =
                syncStore.getState().voiceParticipants[voiceChannelId]?.[
                  targetMember._id.user
                ]
              if (participant) {
                syncStore.removeVoiceParticipant(
                  voiceChannelId,
                  targetMember._id.user,
                )
                syncStore.patchVoiceParticipant(
                  data.voice_channel,
                  targetMember._id.user,
                  participant,
                )
              }
            }
          }),
        ),
        Effect.catch(() =>
          Effect.sync(() => {
          }),
        ),
        Effect.ensuring(Effect.sync(() => setPendingAction(null))),
      ),
    )
  }

  return (
    <>
      {!isSelf ? (
        <>
          <ContextMenuVolume
            label={t('volume')}
            value={volume}
            max={VOICE_USER_VOLUME_MAX}
            step={0.1}
            valueLabel={formatUserVolumeLabel(volume)}
            onValueChange={(next) => voiceListenerStore.setUserVolume(userId, next)}
          />
          <ContextMenuCheckboxItem
            checked={muted}
            closeOnClick={false}
            onCheckedChange={(checked) => {
              voiceListenerStore.setUserMuted(userId, checked === true)
            }}
          >
            {t('muteVoice')}
          </ContextMenuCheckboxItem>
        </>
      ) : null}
      {showServerControls ? (
        <>
          {!isSelf ? <ContextMenuSeparator /> : null}
          {canServerMute ? (
            <ContextMenuCheckboxItem
              variant="destructive"
              checked={serverMuted}
              disabled={pendingAction !== null}
              closeOnClick={false}
              onCheckedChange={(checked) => {
                void editTargetMember(
                  'mute',
                  { can_publish: checked !== true },
                )
              }}
            >
              <MicOffIcon />
              {t('muteMic')}
            </ContextMenuCheckboxItem>
          ) : null}
          {canServerDeafen ? (
            <ContextMenuCheckboxItem
              variant="destructive"
              checked={serverDeafened}
              disabled={pendingAction !== null}
              closeOnClick={false}
              onCheckedChange={(checked) => {
                void editTargetMember(
                  'deafen',
                  { can_receive: checked !== true },
                )
              }}
            >
              <HeadphoneOffIcon />
              {t('muteSound')}
            </ContextMenuCheckboxItem>
          ) : null}
          {canServerMove && moveTargets.length > 0 ? (
            <ContextMenuSub>
              <ContextMenuSubTrigger
                disabled={pendingAction !== null}
              >
                <HeadphonesIcon />
                {t('moveTo')}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {moveTargets.map((channel) => {
                  const channelName =
                    runtimeChannelName(channel) ?? t('channelFallback')
                  return (
                    <ContextMenuItem
                      key={channel._id}
                      disabled={pendingAction !== null}
                      onClick={() => {
                        void editTargetMember(
                          'move',
                          { voice_channel: channel._id },
                        )
                      }}
                    >
                      {channelName}
                    </ContextMenuItem>
                  )
                })}
              </ContextMenuSubContent>
            </ContextMenuSub>
          ) : null}
          {canServerMove ? (
            <ContextMenuItem
              variant="destructive"
              disabled={pendingAction !== null}
              onClick={() => {
                void editTargetMember(
                  'disconnect',
                  { remove: ['VoiceChannel'] },
                )
              }}
            >
              <PhoneOffIcon />
              {t('disconnectAction')}
            </ContextMenuItem>
          ) : null}
        </>
      ) : null}
      <ContextMenuSeparator />
    </>
  )
}
