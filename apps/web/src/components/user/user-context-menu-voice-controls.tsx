// design-allow-file restyle-shared: voice moderation actions use destructive focus treatment.
import { useState } from 'react'
import type {
  Channel,
  DataMemberEdit,
  Member,
  Server,
} from '@syrnike13/api-types'
import { Effect } from 'effect'
import { toast } from 'sonner'
// design-allow-file restyle-shared: voice moderation actions use destructive focus treatment.
import { useTranslations } from '@syrnike13/ui/i18n'

import {
  HeadphonesIcon,
  HeadphoneOffIcon,
  MicOffIcon,
  PhoneOffIcon,
} from '#/components/icons'
import {
  ContextMenuCheckboxItem,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@syrnike13/ui/primitives/context-menu'
import { Slider } from '@syrnike13/ui/primitives/slider'
import { editServerMemberEffect } from '#/features/api/servers-api'
import { syncStore } from '#/features/sync/sync-store'
import {
  formatUserVolumeLabel,
  VOICE_USER_VOLUME_MAX,
  voiceListenerStore,
  useVoiceListenerStore,
} from '#/features/voice/voice-listener-store'
import { runtimeChannelName } from '#/lib/channel-voice'
import { apiErrorMessage } from '#/lib/api/error-message'
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

const voiceActionClassName =
  'grid icon-text-grid items-center gap-x-2'
const destructiveVoiceActionClassName = `${voiceActionClassName} text-destructive focus:bg-destructive/10 focus:text-destructive dark:focus:bg-destructive/20 [&_svg]:text-destructive`

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
    successMessage: string,
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
            toast.success(successMessage)
          }),
        ),
        Effect.catch((error) =>
          Effect.sync(() => {
            toast.error(
              apiErrorMessage(error, t('updateError')),
            )
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
          <div
            className="px-2 py-2"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <ContextMenuGroup>
              <ContextMenuLabel className="px-0 pb-2 text-xs text-muted-foreground">
                {t('volume')}
              </ContextMenuLabel>
            </ContextMenuGroup>
            <div className="flex items-center gap-2">
              <Slider
                className="flex-1"
                min={0}
                max={VOICE_USER_VOLUME_MAX}
                step={0.1}
                value={[volume]}
                onValueChange={(value) => {
                  const next = typeof value === 'number' ? value : value[0]
                  if (next == null) return
                  voiceListenerStore.setUserVolume(userId, next)
                }}
              />
              <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                {formatUserVolumeLabel(volume)}
              </span>
            </div>
          </div>
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
              className={destructiveVoiceActionClassName}
              checked={serverMuted}
              disabled={pendingAction !== null}
              closeOnClick={false}
              onCheckedChange={(checked) => {
                void editTargetMember(
                  'mute',
                  { can_publish: checked !== true },
                  checked === true ? t('micOff') : t('micOn'),
                )
              }}
            >
              <MicOffIcon />
              {t('muteMic')}
            </ContextMenuCheckboxItem>
          ) : null}
          {canServerDeafen ? (
            <ContextMenuCheckboxItem
              className={destructiveVoiceActionClassName}
              checked={serverDeafened}
              disabled={pendingAction !== null}
              closeOnClick={false}
              onCheckedChange={(checked) => {
                void editTargetMember(
                  'deafen',
                  { can_receive: checked !== true },
                  checked === true ? t('soundOff') : t('soundOn'),
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
                className="grid icon-text-icon-grid items-center gap-x-2"
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
                          t('moved', { channel: channelName }),
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
              className={voiceActionClassName}
              variant="destructive"
              disabled={pendingAction !== null}
              onClick={() => {
                void editTargetMember(
                  'disconnect',
                  { remove: ['VoiceChannel'] },
                  t('disconnected'),
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
