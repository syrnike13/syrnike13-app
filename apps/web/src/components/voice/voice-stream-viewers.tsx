import type { User } from '@syrnike13/api-types'
import { useEffect, useRef, useState } from 'react'
import { useTranslations, type Translator } from '@syrnike13/ui/i18n'

import { EyeIcon } from '#/components/icons'
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '#/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import { UserAvatar } from '#/components/user/user-avatar'
import { cn } from '#/lib/utils'

export type StreamViewer = Readonly<{
  id: string
  user?: User
  displayName: string
}>

type VoiceStreamViewersProps = {
  viewers: readonly StreamViewer[]
  /** `count` fits small tiles: an eye and the number of viewers. */
  variant: 'avatars' | 'count'
  className?: string
}

const MAX_VISIBLE_VIEWERS = 3
const POPOVER_CLOSE_DELAY_MS = 150

const viewerChipClass =
  'flex items-center rounded-full bg-background/80 text-foreground shadow-sm backdrop-blur-sm'

export function streamViewerCountLabel(count: number, t: Translator) {
  return t('viewers.count', { count })
}

/** Names for one or two viewers, otherwise the count. */
export function streamViewersSummary(
  viewers: readonly StreamViewer[],
  t: Translator,
) {
  if (viewers.length === 1) {
    return t('viewers.one', { name: viewers[0]!.displayName })
  }
  if (viewers.length === 2) {
    return t('viewers.two', {
      first: viewers[0]!.displayName,
      second: viewers[1]!.displayName,
    })
  }
  return t('viewers.many', {
    count: streamViewerCountLabel(viewers.length, t),
  })
}

/** Who watches a screen share, shown on its tile as in Discord. */
export function VoiceStreamViewers({
  viewers,
  variant,
  className,
}: VoiceStreamViewersProps) {
  if (viewers.length === 0) return null
  return variant === 'count' ? (
    <StreamViewerCount viewers={viewers} className={className} />
  ) : (
    <StreamViewerAvatars viewers={viewers} className={className} />
  )
}

function StreamViewerCount({
  viewers,
  className,
}: {
  viewers: readonly StreamViewer[]
  className?: string
}) {
  const t = useTranslations('voice')

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(viewerChipClass, 'gap-1 px-1.5 py-0.5 text-xs', className)}
            aria-label={streamViewersSummary(viewers, t)}
          >
            <EyeIcon className="size-3 shrink-0" aria-hidden />
            <span className="tabular-nums" aria-hidden>
              {viewers.length}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="z-[420]">
          {streamViewersSummary(viewers, t)}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function StreamViewerAvatars({
  viewers,
  className,
}: {
  viewers: readonly StreamViewer[]
  className?: string
}) {
  const t = useTranslations('voice')
  const [open, setOpen] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelClose = () => {
    if (closeTimerRef.current == null) return
    clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }
  const show = () => {
    cancelClose()
    setOpen(true)
  }
  const scheduleClose = () => {
    cancelClose()
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null
      setOpen(false)
    }, POPOVER_CLOSE_DELAY_MS)
  }
  useEffect(() => cancelClose, [])

  // With overflow the last avatar slot becomes "+N", as in Discord.
  const overflow = viewers.length > MAX_VISIBLE_VIEWERS
  const visible = viewers.slice(
    0,
    overflow ? MAX_VISIBLE_VIEWERS - 1 : MAX_VISIBLE_VIEWERS,
  )
  const hiddenCount = viewers.length - visible.length

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <button
          type="button"
          className={cn(viewerChipClass, 'p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring', className)}
          aria-label={streamViewersSummary(viewers, t)}
          onMouseEnter={show}
          onMouseLeave={scheduleClose}
          onFocus={show}
          onBlur={scheduleClose}
          onClick={(event) => {
            event.stopPropagation()
            setOpen((value) => !value)
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <span className="flex -space-x-1.5">
            {visible.map((viewer) => (
              <UserAvatar
                key={viewer.id}
                user={viewer.user}
                className="size-6 ring-2 ring-background"
                fallbackClassName="size-6 text-[0.625rem]"
                showPresence={false}
                animated="never"
              />
            ))}
            {hiddenCount > 0 ? (
              <span className="z-10 flex size-6 items-center justify-center rounded-full bg-muted text-[0.625rem] font-semibold text-muted-foreground ring-2 ring-background tabular-nums">
                {`+${hiddenCount}`}
              </span>
            ) : null}
          </span>
        </button>
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="end"
        className="z-[420] w-56 p-2"
        onMouseEnter={show}
        onMouseLeave={scheduleClose}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onClick={(event) => event.stopPropagation()}
      >
        <p className="px-1 pb-1.5 text-xs font-semibold uppercase text-muted-foreground">
          {streamViewerCountLabel(viewers.length, t)}
        </p>
        <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
          {viewers.map((viewer) => (
            <li
              key={viewer.id}
              className="flex min-w-0 items-center gap-2 rounded px-1 py-1 text-sm"
            >
              <UserAvatar
                user={viewer.user}
                className="size-6"
                fallbackClassName="size-6 text-[0.625rem]"
                showPresence={false}
                animated="never"
              />
              <span className="min-w-0 truncate">{viewer.displayName}</span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
