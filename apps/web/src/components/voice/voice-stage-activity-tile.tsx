import { useEffect, useState } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'
import type { ActivityInstance } from '@syrnike13/api-types/gateway-schema'
import type { ActivityLayout } from '@syrnike13/activity-sdk/protocol'
import { LogOutIcon, Maximize2Icon, PowerIcon } from '#/components/icons'

import { Button } from '@syrnike13/ui/primitives/button'
import { Spinner } from '@syrnike13/ui/primitives/spinner'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@syrnike13/ui/primitives/context-menu'
import type { StageMediaTileVariant } from '#/components/voice/voice-stage-media-tile'
import {
  VoiceStreamViewers,
  type StreamViewer,
} from '#/components/voice/voice-stream-viewers'
import type { ActivityApplication } from '#/features/activities/activity-api'
import { ActivityApplicationIcon } from '#/features/activities/activity-application-icon'
import { activityErrorMessage } from '#/features/activities/activity-errors'
import { ActivityFrame } from '#/features/activities/activity-frame'
import {
  activityStore,
  isActivityParticipant,
} from '#/features/activities/activity-store'
import { useActivityConnectionStatus } from '#/features/activities/use-activities'
import { cn } from '#/lib/utils'

export type VoiceStageActivityItem = Readonly<{
  id: string
  kind: 'activity'
  instance: ActivityInstance
}>

type VoiceStageActivityTileProps = {
  item: VoiceStageActivityItem
  application: ActivityApplication | null
  currentUserId: string
  participants: readonly StreamViewer[]
  canEnd: boolean
  variant: StageMediaTileVariant
  /** Stage presentation: a popped-out stage reports `popout` to the app. */
  popout?: boolean
  onFocus: (mediaId: string) => void
  onAspectRatioChange?: (aspectRatio: number) => void
}

const ACTIVITY_ASPECT_RATIO = 16 / 9

export function activityFrameLayout(
  variant: StageMediaTileVariant,
  popout: boolean,
): ActivityLayout {
  if (popout) return 'popout'
  return variant === 'grid' ? 'grid' : 'focus'
}

export function VoiceStageActivityTile({
  item,
  application,
  currentUserId,
  participants,
  canEnd,
  variant,
  popout = false,
  onFocus,
  onAspectRatioChange,
}: VoiceStageActivityTileProps) {
  const t = useTranslations('voice')
  const tA = useTranslations('activities')
  const { instance } = item
  const joined = isActivityParticipant(instance, currentUserId)
  const title = application?.name ?? tA('unknownApplication')

  useEffect(() => {
    if (variant === 'focus') onAspectRatioChange?.(ACTIVITY_ASPECT_RATIO)
  }, [onAspectRatioChange, variant])

  const leave = () => {
    void activityStore
      .leave(instance.channel_id, instance.id)
      .catch(() => undefined)
  }
  const end = () => {
    void activityStore.end(instance.channel_id, instance.id).catch(() => undefined)
  }
  const focusLabel =
    variant === 'focus' ? t('actions.returnToGrid') : t('actions.focus')

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <article
            data-testid="voice-stage-activity-tile"
            data-activity-id={instance.id}
            data-joined={joined ? '' : undefined}
            className={cn(
              'group relative size-full min-h-0 overflow-hidden rounded-md bg-card text-card-foreground outline-none',
              variant === 'strip' && '@container aspect-video shrink-0',
              variant === 'grid' && 'hover:brightness-110',
              variant === 'fullscreen' && 'rounded-none',
            )}
          />
        }
      >
        {variant === 'strip' ? (
          // eslint-disable-next-line design/no-lookalike -- stage tile surface
          <button
            type="button"
            className="flex size-full flex-col items-center justify-center gap-1.5 bg-muted/40 px-3 text-center hover:bg-accent"
            onClick={() => onFocus(item.id)}
          >
            <ActivityApplicationIcon application={application} className="size-7" />
            <span className="max-w-full truncate text-xs font-semibold">
              {title}
            </span>
          </button>
        ) : joined && application ? (
          <ActivityFrame
            application={application}
            instance={instance}
            currentUserId={currentUserId}
            layout={activityFrameLayout(variant, popout)}
          />
        ) : (
          <ActivityJoinState
            instance={instance}
            application={application}
            title={title}
            participants={participants}
            compact={variant === 'grid'}
          />
        )}

        {variant !== 'strip' ? (
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className="absolute top-2 right-2 z-20 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            title={focusLabel}
            aria-label={focusLabel}
            onClick={() => onFocus(item.id)}
          >
            <Maximize2Icon />
          </Button>
        ) : null}

        {variant === 'grid' && joined ? (
          <div className="pointer-events-none absolute bottom-2 left-2 z-20 flex max-w-media-inset-xl items-center gap-1.5 rounded bg-media-backdrop/60 px-2 py-1 text-xs font-medium text-on-media">
            <ActivityApplicationIcon application={application} className="size-4" />
            <span className="min-w-0 truncate">{title}</span>
          </div>
        ) : null}
        {variant === 'grid' && joined && participants.length > 0 ? (
          <VoiceStreamViewers
            viewers={participants}
            variant="count"
            labels="activityParticipants"
            className="absolute right-2 bottom-2 z-20"
          />
        ) : null}
      </ContextMenuTrigger>
      <ContextMenuContent className="z-420 min-w-56">
        <ContextMenuItem onClick={() => onFocus(item.id)}>
          <Maximize2Icon />
          {focusLabel}
        </ContextMenuItem>
        {joined || canEnd ? <ContextMenuSeparator /> : null}
        {joined ? (
          <ContextMenuItem onClick={leave}>
            <LogOutIcon />
            {tA('leave')}
          </ContextMenuItem>
        ) : null}
        {canEnd ? (
          <ContextMenuItem variant="destructive" onClick={end}>
            <PowerIcon />
            {tA('endForEveryone')}
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  )
}

function ActivityJoinState({
  instance,
  application,
  title,
  participants,
  compact,
}: {
  instance: ActivityInstance
  application: ActivityApplication | null
  title: string
  participants: readonly StreamViewer[]
  compact: boolean
}) {
  const tA = useTranslations('activities')
  const connection = useActivityConnectionStatus()
  const [joining, setJoining] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const full =
    application !== null &&
    instance.participants.length >= application.max_participants

  const join = () => {
    if (joining) return
    setJoining(true)
    setError(null)
    activityStore
      .join(instance.channel_id, instance.id)
      .catch((cause: unknown) => setError(activityErrorMessage(cause, tA)))
      .finally(() => setJoining(false))
  }

  return (
    <div
      data-testid="activity-join-state"
      className="flex size-full flex-col items-center justify-center gap-3 bg-muted/40 p-4 text-center"
    >
      <ActivityApplicationIcon
        application={application}
        className={compact ? 'size-10' : 'size-14'}
      />
      <div className="flex min-w-0 max-w-full flex-col gap-1">
        <h2 className="truncate text-base font-semibold">{title}</h2>
        {application?.description && !compact ? (
          <p className="line-clamp-2 text-sm text-muted-foreground">
            {application.description}
          </p>
        ) : null}
      </div>
      {participants.length > 0 ? (
        <VoiceStreamViewers
          viewers={participants}
          variant="avatars"
          labels="activityParticipants"
        />
      ) : null}
      {application ? (
        <Button
          type="button"
          disabled={joining || full || connection !== 'connected'}
          onClick={join}
        >
          {joining ? <Spinner data-icon="inline-start" /> : null}
          {full ? tA('full') : joining ? tA('joining') : tA('join')}
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">
          {tA('applicationUnavailable')}
        </p>
      )}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
