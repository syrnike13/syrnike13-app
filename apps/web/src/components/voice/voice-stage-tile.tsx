import { useState } from 'react'
import type { User } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { UserAvatar } from '#/components/user/user-avatar'
import { createChannelInvite } from '#/features/api/servers-api'
import { useAuth } from '#/features/auth/auth-context'
import { VoiceParticipantIcons } from '#/components/voice/voice-participant-icons'
import { VoiceStageVideo } from '#/components/voice/voice-stage-video'
import { useVoice } from '#/features/voice/voice-provider'
import { useVoiceTilePalette } from '#/features/voice/use-voice-tile-palette'
import type { UserVoiceState } from '#/features/sync/voice-types'
import { tilePaletteStyle } from '#/lib/avatar-tile-palette'
import { inviteUrl } from '#/lib/invite-link'
import { cn } from '#/lib/utils'

const TILE_SURFACE =
  'relative aspect-video w-full overflow-hidden rounded-xl shadow-inner transition-[background] duration-500 ease-out'

function stageAvatarSize(compact: boolean) {
  return compact
    ? 'size-14 sm:size-16'
    : 'size-20 sm:size-24 md:size-28 lg:size-32'
}

type VoiceStageTileProps = {
  participant: UserVoiceState
  user?: User
  displayName: string
  speaking?: boolean
  compact?: boolean
  focused?: boolean
  onSelect?: () => void
}

export function VoiceStageTile({
  participant,
  user,
  displayName,
  speaking = false,
  compact = false,
  focused = false,
  onSelect,
}: VoiceStageTileProps) {
  const muted = !participant.is_publishing
  const deafened = !participant.is_receiving
  const avatarSize = stageAvatarSize(compact)
  const palette = useVoiceTilePalette(user, participant.id)
  const voice = useVoice()
  const stageVideo = voice.getStageVideoTrack(participant.id)
  const showVideo = Boolean(stageVideo)

  const canFocus = Boolean(onSelect)

  return (
    <article
      role={canFocus ? 'button' : undefined}
      tabIndex={canFocus ? 0 : undefined}
      className={cn(
        TILE_SURFACE,
        speaking && 'ring-2 ring-primary ring-offset-2 ring-offset-[#1e1f22]',
        canFocus && 'cursor-pointer hover:brightness-110',
        focused && 'min-h-[min(50vh,24rem)]',
      )}
      style={tilePaletteStyle(palette)}
      onClick={canFocus ? onSelect : undefined}
      onKeyDown={
        canFocus
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onSelect?.()
              }
            }
          : undefined
      }
    >
      {showVideo && stageVideo ? (
        <VoiceStageVideo track={stageVideo} />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <UserAvatar
            user={user}
            className={avatarSize}
            fallbackClassName={cn(
              avatarSize,
              compact ? 'text-base' : 'text-xl sm:text-2xl',
            )}
            showPresence={false}
          />
        </div>
      )}

      <div className="absolute top-1.5 right-1.5 sm:top-2 sm:right-2">
        <VoiceParticipantIcons
          muted={muted}
          deafened={deafened}
          camera={participant.camera}
          screenshare={participant.screensharing}
          className="rounded-md bg-black/40 px-1 py-0.5"
        />
      </div>

      <div className="absolute bottom-1.5 left-1.5 max-w-[calc(100%-0.75rem)] rounded bg-black/55 px-1.5 py-0.5 text-xs font-medium text-white sm:bottom-2 sm:left-2 sm:px-2 sm:text-sm">
        <span className="truncate">{displayName}</span>
      </div>
    </article>
  )
}

export function VoiceStageInviteTile({
  channelId,
  compact = false,
}: {
  channelId: string
  compact?: boolean
}) {
  const auth = useAuth()
  const token = auth.session?.token
  const [busy, setBusy] = useState(false)

  async function copyInvite() {
    if (!token) {
      toast.error('Нет сессии')
      return
    }
    setBusy(true)
    try {
      const invite = await createChannelInvite(token, channelId)
      const code = '_id' in invite ? invite._id : ''
      if (!code) throw new Error('Пустой код приглашения')
      await navigator.clipboard.writeText(inviteUrl(code))
      toast.success('Ссылка приглашения скопирована')
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Не удалось создать приглашение',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <article
      className={cn(
        TILE_SURFACE,
        'flex flex-col items-center justify-center gap-2 border border-dashed border-white/15 bg-[#2b2d31]/80 p-4 text-center',
        compact && 'gap-1.5 p-3',
      )}
      style={{
        backgroundImage:
          'linear-gradient(to bottom right, rgb(43 45 49 / 0.95), rgb(35 36 40 / 0.95))',
      }}
    >
      <p className="text-sm font-medium text-foreground">Позовите друзей</p>
      <p className="max-w-[90%] text-[11px] leading-snug text-muted-foreground sm:text-xs">
        Скопируйте ссылку-приглашение на сервер.
      </p>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="mt-1"
        disabled={busy}
        onClick={() => void copyInvite()}
      >
        {busy ? 'Создание…' : 'Скопировать приглашение'}
      </Button>
    </article>
  )
}
