import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import {
  ExternalLinkIcon,
  LogOutIcon,
  Maximize2Icon,
  MonitorXIcon,
} from '#/components/icons'
import { Button } from '#/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import { useVoiceStage } from '#/features/voice/voice-stage-context'
import { useAuth } from '#/features/auth/auth-context'
import { useSyncStore } from '#/features/sync/sync-store'
import { voiceParticipantDisplayName } from '#/features/voice/voice-participant-label'
import { useFloatingCornerAnchor } from '#/hooks/use-floating-corner-anchor'
import {
  clampMiniPlayerPosition,
  miniPlayerCornerPosition,
  miniPlayerVisible,
  miniPlayerWidth,
  MINI_PLAYER_CORNER_KEY,
  MINI_PLAYER_WIDTH_KEY,
  selectMiniPlayerStream,
} from '#/features/voice/stream-mini-player'
import { VoiceStageVideo } from './voice-stage-video'

function readWidth() {
  try {
    return Number(window.localStorage.getItem(MINI_PLAYER_WIDTH_KEY)) || 320
  } catch {
    return 320
  }
}

export function VoiceStreamMiniPlayer() {
  const voice = useVoiceStage()
  const auth = useAuth()
  const users = useSyncStore((state) => state.users)
  const navigate = useNavigate()
  const params = useParams({ strict: false })
  const anchor = useFloatingCornerAnchor(
    MINI_PLAYER_CORNER_KEY,
    'bottom-left',
    true,
  )
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }))
  const [requestedWidth, setRequestedWidth] = useState(readWidth)
  const resize = useRef<{
    pointerId: number
    x: number
    y: number
    width: number
  } | null>(null)
  const suppressResizeClick = useRef(false)
  const width = miniPlayerWidth(requestedWidth, viewport)
  useEffect(() => {
    const update = () =>
      setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  const item = selectMiniPlayerStream(
    voice.streamMediaItems,
    voice.viewedRemoteScreenIds,
    voice.focusedMediaId,
  )
  const visible = miniPlayerVisible({
    hasStream: item !== null,
    sessionChannelId: voice.stageChannelId,
    routeChannelId: params.channelId,
    stageMounted: voice.mountedStageChannelIds.includes(
      voice.stageChannelId ?? '',
    ),
    popoutOpen: voice.popoutWindow !== null && !voice.popoutWindow.closed,
    fullscreen: voice.stageFullscreen,
  })
  if (!visible || !item || !voice.stageChannelId) return null
  const position = anchor.dragPoint
    ? clampMiniPlayerPosition(
        anchor.dragPoint.x - width / 2,
        anchor.dragPoint.y - (width * 9) / 32,
        width,
        viewport,
      )
    : miniPlayerCornerPosition(anchor.corner, width, viewport)
  const right = anchor.corner.endsWith('right')
  const bottom = anchor.corner.startsWith('bottom')
  const returnToChannel = () => {
    if (anchor.consumeSuppressedClick() || suppressResizeClick.current) {
      suppressResizeClick.current = false
      return
    }
    if (!voice.stageChannelId) return
    voice.setFocusedMediaId(item.id)
    void navigate({
      to: '/app/c/$channelId',
      params: { channelId: voice.stageChannelId },
      search: { m: undefined },
    })
  }
  const finishResize = (event: PointerEvent<HTMLButtonElement>) => {
    if (resize.current?.pointerId !== event.pointerId) return
    resize.current = null
    try {
      window.localStorage.setItem(MINI_PLAYER_WIDTH_KEY, String(width))
    } catch {
      /* Storage may be unavailable. */
    }
    event.stopPropagation()
  }
  return (
    <TooltipProvider>
      <section
        aria-label="Мини-плеер трансляции"
        className="group fixed z-40 touch-none select-none overflow-hidden rounded-lg border bg-card text-card-foreground shadow-xl ring-1 ring-shell-divider"
        style={{
          left: position.x,
          top: position.y,
          width,
          aspectRatio: '16 / 9',
        }}
        onClick={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest('[data-mini-control]')
          )
            return
          returnToChannel()
        }}
        onPointerDown={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest('[data-mini-control]')
          )
            return
          anchor.onPointerDown(event)
        }}
        onPointerMove={anchor.onPointerMove}
        onPointerUp={anchor.onPointerUp}
        onPointerCancel={anchor.onPointerCancel}
      >
        <button
          type="button"
          className="absolute inset-0 cursor-grab focus-visible:outline focus-visible:outline-ring active:cursor-grabbing"
          aria-label="Вернуться в канал"
        >
          {item.track ? (
            <VoiceStageVideo
              track={item.track}
              mediaId={item.id}
              fit="contain"
            />
          ) : (
            <span className="text-sm text-muted-foreground">
              {item.error
                ? 'Трансляция недоступна'
                : 'Подключение к трансляции…'}
            </span>
          )}
        </button>
        <div
          className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-1 bg-card/90 p-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
          style={{
            paddingLeft: bottom && right ? 32 : 8,
            paddingRight: bottom && !right ? 32 : 8,
          }}
        >
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {voiceParticipantDisplayName(item.userId, users, auth.user)}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                data-mini-control
                className="pointer-events-auto"
                size="icon-sm"
                variant="ghost"
                aria-label="Вернуться в канал"
                onClick={returnToChannel}
              >
                <LogOutIcon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Вернуться в канал</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                data-mini-control
                className="pointer-events-auto"
                size="icon-sm"
                variant="ghost"
                aria-label="Открыть в отдельном окне"
                onClick={() => {
                  voice.setFocusedMediaId(item.id)
                  voice.openStagePopout()
                }}
              >
                <ExternalLinkIcon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Открыть в отдельном окне</TooltipContent>
          </Tooltip>
          {!item.isLocal ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  data-mini-control
                  className="pointer-events-auto"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Прекратить просмотр"
                  onClick={() => voice.setStageMediaSubscribed(item.id, false)}
                >
                  <MonitorXIcon className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Прекратить просмотр</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
        <button
          type="button"
          data-mini-control
          aria-label="Изменить размер мини-плеера"
          className="absolute size-6 text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-ring"
          style={{
            [right ? 'left' : 'right']: 0,
            [bottom ? 'top' : 'bottom']: 0,
            cursor: right !== bottom ? 'nesw-resize' : 'nwse-resize',
          }}
          onPointerDown={(event) => {
            if (event.button !== 0 || !event.isPrimary) return
            event.stopPropagation()
            event.currentTarget.setPointerCapture(event.pointerId)
            suppressResizeClick.current = true
            resize.current = {
              pointerId: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              width,
            }
          }}
          onPointerMove={(event) => {
            const start = resize.current
            if (!start || start.pointerId !== event.pointerId) return
            event.stopPropagation()
            const dx = (event.clientX - start.x) * (right ? -1 : 1)
            const dy = ((event.clientY - start.y) * (bottom ? -1 : 1) * 16) / 9
            setRequestedWidth(
              miniPlayerWidth(
                start.width + (Math.abs(dx) >= Math.abs(dy) ? dx : dy),
                viewport,
              ),
            )
          }}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          onClick={(event) => {
            event.stopPropagation()
            suppressResizeClick.current = false
          }}
          onKeyDown={(event) => {
            if (
              !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(
                event.key,
              )
            )
              return
            event.preventDefault()
            const next = miniPlayerWidth(
              width +
                (event.key === 'ArrowRight' || event.key === 'ArrowUp'
                  ? 16
                  : -16),
              viewport,
            )
            setRequestedWidth(next)
            try {
              window.localStorage.setItem(MINI_PLAYER_WIDTH_KEY, String(next))
            } catch {
              /* Storage may be unavailable. */
            }
          }}
        >
          <Maximize2Icon className="mx-auto size-3" />
        </button>
      </section>
    </TooltipProvider>
  )
}
