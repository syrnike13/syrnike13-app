import { lazy, Suspense, useEffect, useState } from 'react'
import {
  Gamepad2Icon,
  Loader2Icon,
  LogOutIcon,
  Maximize2Icon,
} from '#/components/icons'

import { Button } from '#/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '#/components/ui/context-menu'
import type { StageMediaTileVariant } from '#/components/voice/voice-stage-media-tile'
import {
  getFirstPartyChannelActivity,
  type FirstPartyChannelActivity,
} from '#/features/activities/channel-activity-catalog'
import { channelActivityClient } from '#/features/activities/channel-activity-client'
import type {
  ChannelActivityInstance,
  ChannelActivityViewState,
} from '#/features/activities/channel-activity-types'
import { cn } from '#/lib/utils'

const EmbeddedActivityFrame = lazy(() =>
  import('#/features/activities/channel-activity-panel').then((module) => ({
    default: module.EmbeddedActivityFrame,
  })),
)

export type VoiceStageActivityItem = Readonly<{
  id: string
  kind: 'activity'
  instance: ChannelActivityInstance
}>

type VoiceStageActivityTileProps = {
  item: VoiceStageActivityItem
  activity: ChannelActivityViewState
  currentUserId: string
  variant: StageMediaTileVariant
  onFocus: (mediaId: string) => void
  onAspectRatioChange?: (aspectRatio: number) => void
}

const ACTIVITY_ASPECT_RATIO = 16 / 9

export function VoiceStageActivityTile({
  item,
  activity,
  currentUserId,
  variant,
  onFocus,
  onAspectRatioChange,
}: VoiceStageActivityTileProps) {
  const application = getFirstPartyChannelActivity(item.instance.application_id)
  const joined = item.instance.participant_ids.includes(currentUserId)
  const [joining, setJoining] = useState(false)

  useEffect(() => {
    if (joined || activity.error || activity.transport !== 'connected') {
      setJoining(false)
    }
  }, [activity.error, activity.transport, joined])

  useEffect(() => {
    if (variant === 'focus') onAspectRatioChange?.(ACTIVITY_ASPECT_RATIO)
  }, [onAspectRatioChange, variant])

  const join = () => {
    if (joining || activity.transport !== 'connected') return
    setJoining(true)
    channelActivityClient.join(item.instance.channel_id, item.instance.id)
  }
  const leave = () => {
    channelActivityClient.leave(item.instance.channel_id, item.instance.id)
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <article
          data-testid="voice-stage-activity-tile"
          data-activity-id={item.instance.id}
          className={cn(
            'group relative size-full min-h-0 overflow-hidden rounded-md border border-border bg-card text-card-foreground outline-none ring-offset-2 ring-offset-background',
            variant !== 'focus' &&
              variant !== 'fullscreen' &&
              'hover:border-primary/50',
            variant === 'fullscreen' && 'rounded-none border-0',
          )}
        >
          {variant === 'strip' ? (
            <button
              type="button"
              className="flex size-full flex-col items-center justify-center gap-1.5 bg-muted/40 px-3 text-center hover:bg-accent"
              onClick={() => onFocus(item.id)}
            >
              <Gamepad2Icon className="size-6 text-primary" aria-hidden />
              <span className="max-w-full truncate text-xs font-semibold">
                {application?.title ?? 'Активность'}
              </span>
            </button>
          ) : joined && application ? (
            <Suspense fallback={<ActivityLoadingState />}>
              <EmbeddedActivityFrame
                key={item.instance.id}
                application={application}
                instance={item.instance}
                error={activity.error}
                transport={activity.transport}
                currentUserId={currentUserId}
                onCommand={(command) =>
                  channelActivityClient.command(
                    item.instance.channel_id,
                    item.instance.id,
                    command,
                  )
                }
                onClose={leave}
              />
            </Suspense>
          ) : (
            <ActivityJoinState
              application={application}
              joining={joining}
              connected={activity.transport === 'connected'}
              error={activity.error}
              onJoin={join}
            />
          )}

          {variant !== 'strip' ? (
            <Button
              type="button"
              variant="secondary"
              size="icon"
              className="absolute top-2 right-2 z-20 size-8 border border-border bg-card/90 text-card-foreground shadow-sm opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
              title={variant === 'focus' ? 'Вернуть в сетку' : 'Сфокусировать'}
              aria-label={
                variant === 'focus' ? 'Вернуть в сетку' : 'Сфокусировать'
              }
              onClick={() => onFocus(item.id)}
            >
              <Maximize2Icon className="size-4" />
            </Button>
          ) : null}

          {variant !== 'focus' &&
          variant !== 'fullscreen' &&
          variant !== 'strip' ? (
            <div className="pointer-events-none absolute bottom-2 left-2 z-20 flex max-w-[calc(100%-3.5rem)] items-center gap-1.5 rounded bg-card/90 px-2 py-1 text-xs font-medium text-card-foreground shadow-sm">
              <Gamepad2Icon className="size-3.5 shrink-0 text-primary" />
              <span className="truncate">
                {application?.title ?? 'Активность'}
              </span>
            </div>
          ) : null}
        </article>
      </ContextMenuTrigger>
      <ContextMenuContent className="z-[420] min-w-56">
        <ContextMenuItem onSelect={() => onFocus(item.id)}>
          <Maximize2Icon />
          {variant === 'focus' ? 'Вернуть в сетку' : 'Сфокусировать'}
        </ContextMenuItem>
        {joined ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={leave}>
              <LogOutIcon />
              Покинуть Активность
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  )
}

function ActivityLoadingState() {
  return (
    <div
      className="flex size-full items-center justify-center bg-background text-muted-foreground"
      role="status"
    >
      <Loader2Icon className="mr-2 size-5 animate-spin" />
      Загружаем Активность…
    </div>
  )
}

function ActivityJoinState({
  application,
  joining,
  connected,
  error,
  onJoin,
}: {
  application?: FirstPartyChannelActivity
  joining: boolean
  connected: boolean
  error: ChannelActivityViewState['error']
  onJoin: () => void
}) {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-3 bg-muted/40 p-5 text-center">
      <div className="flex size-12 items-center justify-center rounded-xl bg-primary/15 text-primary">
        <Gamepad2Icon className="size-6" />
      </div>
      <div>
        <h2 className="text-base font-semibold">
          {application?.title ?? 'Неподдерживаемая Активность'}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {application
            ? 'Участники голосового канала уже играют.'
            : 'Обновите клиент, чтобы открыть это приложение.'}
        </p>
      </div>
      {application ? (
        <Button type="button" disabled={joining || !connected} onClick={onJoin}>
          {joining ? <Loader2Icon className="size-4 animate-spin" /> : null}
          {joining ? 'Подключаем…' : 'Присоединиться'}
        </Button>
      ) : null}
      {error ? (
        <p className="text-xs text-destructive">Не удалось подключиться.</p>
      ) : null}
    </div>
  )
}
