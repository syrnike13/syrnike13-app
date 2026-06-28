import { useState } from 'react'
import type {
  Channel,
  DataMemberEdit,
  Member,
  Server,
} from '@syrnike13/api-types'
import { toast } from 'sonner'

import {
  HeadphonesIcon,
  HeadphoneOffIcon,
  MicOffIcon,
  PhoneOffIcon,
} from '#/components/icons'
import {
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '#/components/ui/context-menu'
import { Slider } from '#/components/ui/slider'
import { editServerMember } from '#/features/api/servers-api'
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
  calculateChannelPermissions,
  ChannelPermission,
  hasChannelPermission,
} from '#/lib/permissions'

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
  const channelType = (channel as { channel_type?: string }).channel_type
  return channelType === 'TextChannel' || channelType === 'VoiceChannel'
}

function canUseVoiceMoveTarget(
  server: Server,
  channel: Channel,
  actorMember: Member | undefined,
  actorUserId: string,
) {
  if (!isServerVoiceMoveTarget(channel)) return false

  return hasChannelPermission(
    calculateChannelPermissions(
      server,
      channel as Extract<Channel, { channel_type: 'TextChannel' }>,
      actorMember,
      actorUserId,
    ),
    ChannelPermission.Connect,
  )
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
  const volume = useVoiceListenerStore((s) => s.getUserVolume(userId))
  const muted = useVoiceListenerStore((s) => s.getUserMuted(userId))
  const [pendingAction, setPendingAction] = useState<ServerVoiceAction | null>(
    null,
  )
  const canServerMute =
    server &&
    canMuteServerMember(server, actorMember, actorUserId, targetMember)
  const canServerDeafen =
    server &&
    canDeafenServerMember(server, actorMember, actorUserId, targetMember)
  const canServerMove =
    server &&
    voiceChannelId &&
    canMoveServerMember(server, actorMember, actorUserId, targetMember)
  const moveTargets =
    server && actorUserId
      ? moveVoiceChannels.filter((channel) => {
          if (channel._id === voiceChannelId) return false
          return canUseVoiceMoveTarget(server, channel, actorMember, actorUserId)
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

  async function editTargetMember(
    action: ServerVoiceAction,
    data: DataMemberEdit,
    successMessage: string,
  ) {
    if (!token || !server || !targetMember || pendingAction) return

    setPendingAction(action)
    try {
      const updated = await editServerMember(
        token,
        server._id,
        targetMember._id.user,
        data,
      )
      syncStore.upsertMembers([updated])
      if (data.remove?.includes('VoiceChannel') && voiceChannelId) {
        syncStore.removeVoiceParticipant(voiceChannelId, targetMember._id.user)
      }
      if (data.voice_channel && voiceChannelId) {
        const participant =
          syncStore.getState().voiceParticipants[voiceChannelId]?.[
            targetMember._id.user
          ]
        if (participant) {
          syncStore.removeVoiceParticipant(voiceChannelId, targetMember._id.user)
          syncStore.patchVoiceParticipant(
            data.voice_channel,
            targetMember._id.user,
            participant,
          )
        }
      }
      toast.success(successMessage)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось изменить голос',
      )
    } finally {
      setPendingAction(null)
    }
  }

  return (
    <>
      <div
        className="px-2 py-2"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <ContextMenuLabel className="px-0 pb-2 text-xs text-muted-foreground">
          Громкость голоса
        </ContextMenuLabel>
        <div className="flex items-center gap-2">
          <Slider
            className="flex-1"
            min={0}
            max={VOICE_USER_VOLUME_MAX}
            step={0.1}
            value={[volume]}
            onValueChange={([next]) => {
              voiceListenerStore.setUserVolume(userId, next)
            }}
          />
          <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
            {formatUserVolumeLabel(volume)}
          </span>
        </div>
      </div>
      <ContextMenuCheckboxItem
        indicatorPosition="end"
        checked={muted}
        onSelect={(event) => event.preventDefault()}
        onCheckedChange={(checked) => {
          voiceListenerStore.setUserMuted(userId, checked === true)
        }}
      >
        Заглушить голос
      </ContextMenuCheckboxItem>
      {showServerControls ? (
        <>
          <ContextMenuSeparator />
          <ContextMenuLabel className="px-2 py-1 text-xs text-muted-foreground">
            Модерация голоса
          </ContextMenuLabel>
          {canServerMute ? (
            <ContextMenuCheckboxItem
              indicatorPosition="end"
              checked={serverMuted}
              disabled={pendingAction !== null}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) => {
                void editTargetMember(
                  'mute',
                  { can_publish: checked !== true },
                  checked === true
                    ? 'Микрофон участника отключён'
                    : 'Микрофон участника включён',
                )
              }}
            >
              <MicOffIcon />
              Отключить микрофон
            </ContextMenuCheckboxItem>
          ) : null}
          {canServerDeafen ? (
            <ContextMenuCheckboxItem
              indicatorPosition="end"
              checked={serverDeafened}
              disabled={pendingAction !== null}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) => {
                void editTargetMember(
                  'deafen',
                  { can_receive: checked !== true },
                  checked === true
                    ? 'Звук участника отключён'
                    : 'Звук участника включён',
                )
              }}
            >
              <HeadphoneOffIcon />
              Отключить звук
            </ContextMenuCheckboxItem>
          ) : null}
          {canServerMove && moveTargets.length > 0 ? (
            <ContextMenuSub>
              <ContextMenuSubTrigger disabled={pendingAction !== null}>
                <HeadphonesIcon />
                Переместить в
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {moveTargets.map((channel) => {
                  const channelName =
                    runtimeChannelName(channel) ?? 'Голосовой канал'
                  return (
                    <ContextMenuItem
                      key={channel._id}
                      disabled={pendingAction !== null}
                      onSelect={() => {
                        void editTargetMember(
                          'move',
                          { voice_channel: channel._id },
                          `Участник перемещён в ${channelName}`,
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
              onSelect={() => {
                void editTargetMember(
                  'disconnect',
                  { remove: ['VoiceChannel'] },
                  'Участник отключён от голосового канала',
                )
              }}
            >
              <PhoneOffIcon />
              Отключить от голосового канала
            </ContextMenuItem>
          ) : null}
        </>
      ) : null}
      <ContextMenuSeparator />
    </>
  )
}
