import { useState } from 'react'
import type { User } from '@syrnike13/api-types'
import { Effect } from 'effect'
import { useTranslations } from '@syrnike13/ui/i18n'

import { Button } from '@syrnike13/ui/primitives/button'
import { UserAvatar } from '#/components/user/user-avatar'
import { createChannelInviteEffect } from '#/features/api/invites-api'
import { useAuth } from '#/features/auth/auth-context'
import {
  VoiceOnAirBadge,
  VoiceParticipantIcons,
} from '#/components/voice/voice-participant-icons'
import { useVoiceTilePalette } from '#/features/voice/use-voice-tile-palette'
import type { UserVoiceState } from '#/features/sync/voice-types'
import type { CSSVars } from '#/lib/css-vars'
import { cn } from '#/lib/utils'
import { writeClipboardTextEffect } from '#/lib/clipboard'
import { inviteUrl } from '#/lib/invite-link'

const TILE_SURFACE =
  'relative aspect-video w-full overflow-hidden rounded-xl shadow-inner transition-colors duration-500 ease-out'

type VoiceStageTileProps = {
  participant: UserVoiceState
  user?: User
  displayName: string
  dimmed?: boolean
  speaking?: boolean
  compact?: boolean
  focused?: boolean
  onSelect?: () => void
}

export function VoiceStageTile({
  participant,
  user,
  displayName,
  dimmed = false,
  speaking = false,
  compact = false,
  focused = false,
  onSelect,
}: VoiceStageTileProps) {
  const muted = participant.server_muted || participant.self_mute
  const deafened = participant.server_deafened || participant.self_deaf
  const avatarSize = compact
    ? 'size-14 sm:size-16'
    : 'size-20 sm:size-24 md:size-28 lg:size-32'
  const palette = useVoiceTilePalette(user, participant.id)

  const canFocus = Boolean(onSelect)

  return (
    // eslint-disable-next-line design/no-lookalike -- focusable stage tile (role=button, Enter/Space) on the participant palette
    <article
      role={canFocus ? 'button' : undefined}
      tabIndex={canFocus ? 0 : undefined}
      className={cn(
        TILE_SURFACE,
        'tile-palette',
        dimmed && 'opacity-50',
        speaking && 'ring-2 ring-chart-3 ring-offset-2 ring-offset-background',
        canFocus && 'cursor-pointer hover:brightness-110',
        focused && 'min-h-voice-tile',
      )}
      style={
        {
          '--tile-from': palette.from,
          '--tile-to': palette.to,
        } as CSSVars
      }
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
      <div className="absolute inset-0 flex items-center justify-center">
        <UserAvatar
          user={user}
          className={avatarSize}
          fallbackClassName={cn(
            avatarSize,
            compact ? 'text-base' : 'text-xl sm:text-2xl',
          )}
          animated="speaking"
          speaking={speaking}
          showPresence={false}
        />
      </div>

      {participant.screensharing ? (
        <div className="absolute top-1.5 right-1.5 z-10 sm:top-2 sm:right-2">
          <VoiceOnAirBadge />
        </div>
      ) : null}

      <div className="absolute bottom-1.5 left-1.5 z-10 flex max-w-media-inset min-w-0 items-center gap-1.5 rounded bg-media-backdrop/55 px-1.5 py-0.5 text-xs font-medium text-on-media sm:bottom-2 sm:left-2 sm:px-2 sm:text-sm">
        <VoiceParticipantIcons
          muted={muted}
          deafened={deafened}
          serverMuted={participant.server_muted}
          serverDeafened={participant.server_deafened}
          camera={participant.camera}
        />
        <span className="min-w-0 truncate">{displayName}</span>
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
  const t = useTranslations('voice')
  const auth = useAuth()
  const token = auth.session?.token
  const [busy, setBusy] = useState(false)

  async function copyInvite() {
    if (!token) {
      return
    }
    setBusy(true)
    await Effect.runPromise(
      Effect.gen(function*() {
        const invite = yield* createChannelInviteEffect(token, channelId, {})
        const code = '_id' in invite ? invite._id : ''
        if (!code) {
          return yield* Effect.fail(
            new Error(t('errors.inviteEmpty')),
          )
        }
        yield* writeClipboardTextEffect(inviteUrl(code))
        yield* Effect.sync(() =>
          {},
        )
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
          }),
        ),
        Effect.ensuring(Effect.sync(() => setBusy(false))),
      ),
    )
  }

  return (
    <article
      className={cn(
        TILE_SURFACE,
        'flex flex-col items-center justify-center gap-2 border border-dashed border-on-media/15 bg-muted/80 p-4 text-center',
        compact && 'gap-1.5 p-3',
      )}
    >
      <p className="text-sm font-medium text-foreground">
        {t('actions.inviteFriends')}
      </p>
      <p className="max-w-90/100 text-xs leading-snug text-muted-foreground sm:text-xs">
        {t('actions.inviteDescription')}
      </p>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="mt-1"
        disabled={busy}
        onClick={() => void copyInvite()}
      >
        {busy ? t('actions.creatingInvite') : t('actions.copyInvite')}
      </Button>
    </article>
  )
}
