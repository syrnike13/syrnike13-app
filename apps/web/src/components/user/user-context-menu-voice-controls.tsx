import { useState } from 'react'
import type { DataMemberEdit, Member, Server } from '@syrnike13/api-types'
import { toast } from 'sonner'

import {
  HeadphoneOffIcon,
  MicOffIcon,
  PhoneOffIcon,
} from '#/components/icons'
import {
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
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
import {
  canDeafenServerMember,
  canMoveServerMember,
  canMuteServerMember,
} from '#/lib/permissions'

type UserContextMenuVoiceControlsProps = {
  userId: string
  token?: string
  server?: Server
  actorMember?: Member
  actorUserId?: string
  targetMember?: Member
  voiceChannelId?: string
}

type ServerVoiceAction = 'mute' | 'deafen' | 'disconnect'

export function UserContextMenuVoiceControls({
  userId,
  token,
  server,
  actorMember,
  actorUserId,
  targetMember,
  voiceChannelId,
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
  const canServerDisconnect =
    server &&
    voiceChannelId &&
    canMoveServerMember(server, actorMember, actorUserId, targetMember)
  const serverMuted = targetMember?.can_publish === false
  const serverDeafened = targetMember?.can_receive === false
  const showServerControls = Boolean(
    token &&
      server &&
      targetMember &&
      (canServerMute || canServerDeafen || canServerDisconnect),
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
          {canServerDisconnect ? (
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
