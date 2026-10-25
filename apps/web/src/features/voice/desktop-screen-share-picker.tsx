import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Effect, Fiber, Option, Schema } from 'effect'
import { useTranslations, type Translator } from '@syrnike13/ui/i18n'
import {
  AppWindowIcon,
  Gamepad2Icon,
  MonitorIcon,
  Settings2Icon,
} from '#/components/icons'
import type {
  DesktopDisplayMediaRequest,
  DesktopDisplayMediaSource,
} from '@syrnike13/platform'

import {
  Button,
  buttonVariants,
} from '@syrnike13/ui/primitives/button'
import { Spinner } from '@syrnike13/ui/primitives/spinner'
import { Checkbox } from '@syrnike13/ui/primitives/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@syrnike13/ui/primitives/dialog'
import { Empty, EmptyDescription } from '@syrnike13/ui/primitives/empty'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@syrnike13/ui/primitives/tabs'
import { Separator } from '@syrnike13/ui/primitives/separator'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemTitle,
} from '@syrnike13/ui/primitives/item'
import { usePlatform } from '#/platform/use-platform'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@syrnike13/ui/primitives/popover'
import {
  ScreenShareFpsOptions,
  ScreenShareResolutionOptions,
  StreamSettingsSubmenu,
  useScreenShareQuality,
} from '#/components/voice/voice-screen-share-quality'
import {
  desktopScreenShareSourceLabel,
  rememberDesktopScreenShareBroadcastSource,
} from '#/features/voice/voice-broadcast-source'

type SourceTab = 'screen' | 'applications'
type LoadedSourcePage = {
  requestId: string
  page: number
  sources: DesktopDisplayMediaSource[]
}
const SourceTabSchema = Schema.Literals(['screen', 'applications'])
const DISPLAY_SOURCE_PAGE_SIZE = 24
export const DISPLAY_SOURCE_VISUAL_CONCURRENCY = 4

type DisplaySourceVisualLoadOptions = {
  requestId: string
  sources: readonly DesktopDisplayMediaSource[]
  loadVisual: (
    requestId: string,
    sourceId: string,
  ) => Promise<DesktopDisplayMediaSource | null>
  isCurrent: () => boolean
  onVisual: (visual: DesktopDisplayMediaSource) => void
}

export const loadDisplaySourceVisualsEffect = Effect.fn(
  'desktopScreenSharePicker.loadVisuals',
)(function*(options: DisplaySourceVisualLoadOptions) {
  yield* Effect.forEach(
    options.sources.slice(0, DISPLAY_SOURCE_PAGE_SIZE),
    (source) =>
      Effect.gen(function*() {
        if (!options.isCurrent()) return
        const visual = yield* Effect.tryPromise({
          try: () => options.loadVisual(options.requestId, source.id),
          catch: (cause) => cause,
        })
        if (visual && options.isCurrent()) options.onVisual(visual)
      }).pipe(Effect.catch(() => Effect.void)),
    { concurrency: DISPLAY_SOURCE_VISUAL_CONCURRENCY, discard: true },
  )
})

const SOURCE_TABS: Array<{
  value: SourceTab
  labelKey: string
  icon: typeof MonitorIcon
}> = [
  { value: 'screen', labelKey: 'sharePicker.screens', icon: MonitorIcon },
  {
    value: 'applications',
    labelKey: 'sharePicker.applications',
    icon: AppWindowIcon,
  },
]

const EMPTY_TAB_TEXT_KEYS: Record<SourceTab, string> = {
  screen: 'sharePicker.noScreens',
  applications: 'sharePicker.noApplications',
}

export function sourceAudioLabel(
  source: DesktopDisplayMediaSource,
  t: Translator,
) {
  if (source.audioAvailable === false) return t('sharePicker.soundUnavailable')
  if (source.type === 'screen') return t('sharePicker.systemSound')
  if (source.type === 'game') return t('sharePicker.gameSound')
  return t('sharePicker.windowSound')
}

export function canRequestSourceAudio(
  source: DesktopDisplayMediaSource | null | undefined,
) {
  return source?.audioAvailable !== false
}

export type ScreenSharePickerDemo = {
  request: DesktopDisplayMediaRequest
  sources: readonly DesktopDisplayMediaSource[]
  onSelect: (source: DesktopDisplayMediaSource, audioRequested: boolean) => void
  onCancel: () => void
}

export function DesktopScreenSharePicker({
  demo,
}: {
  /** Dev-only источник данных: показывает настоящий пикер без desktop-моста. */
  demo?: ScreenSharePickerDemo
} = {}) {
  const t = useTranslations('voice')
  const { desktop } = usePlatform()
  const [request, setRequest] = useState<DesktopDisplayMediaRequest | null>(
    demo?.request ?? null,
  )
  const [sources, setSources] = useState<DesktopDisplayMediaSource[]>([])
  const [loadedPage, setLoadedPage] = useState<LoadedSourcePage | null>(null)
  const loadedVisuals = useRef(new Set<string>())
  const [activeTab, setActiveTab] = useState<SourceTab>('screen')
  const [audioRequested, setAudioRequested] = useState(
    demo?.request.audioRequested ?? true,
  )
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(0)
  const [hasPreviousPage, setHasPreviousPage] = useState(false)
  const [hasNextPage, setHasNextPage] = useState(false)
  const [submittingSourceId, setSubmittingSourceId] = useState<string | null>(
    null,
  )

  useEffect(() => {
    if (!desktop || demo) return
    return desktop.media.onRequest((nextRequest) => {
      setRequest(nextRequest)
      setSources([])
      setLoadedPage(null)
      loadedVisuals.current.clear()
      setActiveTab('screen')
      setAudioRequested(nextRequest.audioRequested)
      setPage(0)
      setHasPreviousPage(false)
      setHasNextPage(false)
      setSubmittingSourceId(null)
    })
  }, [demo, desktop])

  useEffect(() => {
    if (!demo) return
    loadedVisuals.current.clear()
    setSources([...demo.sources])
    setLoadedPage(null)
    setLoading(false)
    setHasPreviousPage(false)
    setHasNextPage(false)
    setActiveTab(
      demo.sources.some((source) => source.type === 'screen')
        ? 'screen'
        : 'applications',
    )
  }, [demo])

  const requestId = request?.id ?? null
  useEffect(() => {
    if (demo || !desktop || !requestId) return

    let current = true
    setLoading(true)
    setSources([])
    setLoadedPage(null)
    loadedVisuals.current.clear()
    const fiber = Effect.runFork(
      Effect.tryPromise({
        try: () => desktop.media.getDisplaySources(requestId, page),
        catch: (cause) => cause,
      }).pipe(
        Effect.flatMap((nextPage) =>
          Effect.gen(function*() {
            if (!current) return
            yield* Effect.sync(() => {
              setSources(nextPage.sources)
              setLoadedPage({ requestId, page, sources: nextPage.sources })
              setHasPreviousPage(nextPage.hasPrevious)
              setHasNextPage(nextPage.hasNext)
              setActiveTab(
                nextPage.sources.some((source) => source.type === 'screen')
                  ? 'screen'
                  : 'applications',
              )
              setLoading(false)
            })
          }),
        ),
        Effect.catch(() =>
          Effect.sync(() => {
            if (!current) return
            setLoading(false)
          }),
        ),
      ),
    )

    return () => {
      current = false
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [desktop, page, requestId, t])

  useEffect(() => {
    if (!desktop || demo || !requestId || loadedPage?.requestId !== requestId || loadedPage.page !== page) return
    const visibleSources = loadedPage.sources.filter((source) =>
      (activeTab === 'screen' ? source.type === 'screen' : source.type !== 'screen') &&
      !loadedVisuals.current.has(source.id),
    )
    let current = true
    const fiber = Effect.runFork(loadDisplaySourceVisualsEffect({
      requestId,
      sources: visibleSources,
      loadVisual: (activeRequestId, sourceId) =>
        desktop.media.getDisplaySourceVisual(activeRequestId, sourceId),
      isCurrent: () => current,
      onVisual: (visual) => {
        loadedVisuals.current.add(visual.id)
        setSources((currentSources) => currentSources.map((source) =>
          source.id === visual.id ? visual : source,
        ))
      },
    }))
    return () => {
      current = false
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [activeTab, desktop, demo, loadedPage, page, requestId])

  const screenSources = useMemo(
    () => sources.filter((source) => source.type === 'screen'),
    [sources],
  )
  const applicationSources = useMemo(
    () => sources.filter((source) => source.type !== 'screen'),
    [sources],
  )
  const cancelRequest = useCallback(() => {
    const activeRequest = request
    setRequest(null)
    setSources([])
    setLoadedPage(null)
    setPage(0)
    setHasPreviousPage(false)
    setHasNextPage(false)
    setSubmittingSourceId(null)
    if (demo) {
      demo.onCancel()
    } else if (desktop && activeRequest) {
      void desktop.media.cancelRequest(activeRequest.id)
    }
  }, [demo, desktop, request])

  const selectSource = useCallback(
    async (source: DesktopDisplayMediaSource) => {
      const selectedAudioRequested =
        audioRequested && canRequestSourceAudio(source)

      if (demo) {
        demo.onSelect(source, selectedAudioRequested)
        setRequest(null)
        setSources([])
        setLoadedPage(null)
        setPage(0)
        setHasPreviousPage(false)
        setHasNextPage(false)
        setSubmittingSourceId(null)
        return
      }

      if (!desktop || !request) return

      setSubmittingSourceId(source.id)
      try {
        const selected = await desktop.media.selectDisplaySource(
          request.id,
          source.id,
          selectedAudioRequested,
        )
        if (!selected) {
          setSubmittingSourceId(null)
          return
        }
        rememberDesktopScreenShareBroadcastSource(source)
        setRequest(null)
        setSources([])
        setLoadedPage(null)
        setPage(0)
        setHasPreviousPage(false)
        setHasNextPage(false)
        setSubmittingSourceId(null)
      } catch (error) {
        setSubmittingSourceId(null)
      }
    },
    [audioRequested, demo, desktop, request, t],
  )

  const open = Boolean(request)
  const submitting = submittingSourceId !== null

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && cancelRequest()}>
      <DialogContent
        showCloseButton={false}
        className="grid aspect-4/3 w-screen-share-picker max-w-none grid-rows-media-picker gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <DialogTitle className="sr-only">{t('sharePicker.title')}</DialogTitle>
        <DialogDescription className="sr-only">
          {t('sharePicker.description')}
        </DialogDescription>

        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            const decoded = Schema.decodeUnknownOption(SourceTabSchema)(value)
            if (Option.isSome(decoded)) setActiveTab(decoded.value)
          }}
          className="min-h-0 gap-0"
        >
          <TabsList className="mx-4 mt-4 w-picker-inset shrink-0">
            {SOURCE_TABS.map((tab) => {
              const Icon = tab.icon
              const count =
                tab.value === 'screen'
                  ? screenSources.length
                  : applicationSources.length
              return (
                <TabsTrigger key={tab.value} value={tab.value}>
                  <Icon />
                  <span>{t(tab.labelKey)}</span>
                  <span className="text-xs text-muted-foreground">{count}</span>
                </TabsTrigger>
              )
            })}
          </TabsList>

          <TabsContent value="screen" className="min-h-0 overflow-y-auto">
            <div className="p-4">
              <DisplaySourceGrid
                sources={screenSources}
                submittingSourceId={submittingSourceId}
                loading={loading}
                emptyText={t(EMPTY_TAB_TEXT_KEYS.screen)}
                onShare={selectSource}
              />
            </div>
          </TabsContent>
          <TabsContent
            value="applications"
            className="min-h-0 overflow-y-auto"
          >
            <div className="p-4">
              <DisplaySourceGrid
                sources={applicationSources}
                submittingSourceId={submittingSourceId}
                loading={loading}
                emptyText={t(EMPTY_TAB_TEXT_KEYS.applications)}
                onShare={selectSource}
              />
            </div>
          </TabsContent>
        </Tabs>

        <Separator />
        <DialogFooter variant="bare" className="flex-row items-center justify-between sm:justify-between">
          <ScreenSharePickerQualitySummary />
          <div className="flex items-center gap-2">
            {hasPreviousPage || hasNextPage ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((currentPage) => Math.max(0, currentPage - 1))}
                  disabled={!hasPreviousPage || loading || submitting}
                >
                  {t('sharePicker.back')}
                </Button>
                <span className="min-w-8 text-center text-xs text-muted-foreground">
                  {page + 1}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((currentPage) => currentPage + 1)}
                  disabled={!hasNextPage || loading || submitting}
                >
                  {t('sharePicker.next')}
                </Button>
              </>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              onClick={cancelRequest}
              disabled={submitting}
            >
              {t('sharePicker.cancel')}
            </Button>
            <ScreenSharePickerSettings
              audioSupported={demo ? true : Boolean(request?.nativeVideo)}
              audioRequested={audioRequested}
              onAudioRequestedChange={setAudioRequested}
              disabled={submitting}
            />
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DisplaySourceGrid({
  sources,
  submittingSourceId,
  loading,
  emptyText,
  onShare,
}: {
  sources: DesktopDisplayMediaSource[]
  submittingSourceId: string | null
  loading: boolean
  emptyText: string
  onShare: (source: DesktopDisplayMediaSource) => void
}) {
  if (loading) {
    return (
      <div className="grid min-h-64 place-items-center text-muted-foreground">
        <Spinner className="size-6" />
      </div>
    )
  }

  if (sources.length === 0) {
    return (
      <div className="grid min-h-64 place-items-center rounded-md border border-dashed border-border">
        <Empty>
          <EmptyDescription>{emptyText}</EmptyDescription>
        </Empty>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-3">
      {sources.map((source) => (
        <DisplaySourceTile
          key={source.id}
          source={source}
          submitting={source.id === submittingSourceId}
          disabled={submittingSourceId !== null}
          onShare={() => onShare(source)}
        />
      ))}
    </div>
  )
}

function DisplaySourceTile({
  source,
  submitting,
  disabled,
  onShare,
}: {
  source: DesktopDisplayMediaSource
  submitting: boolean
  disabled: boolean
  onShare: () => void
}) {
  const t = useTranslations('voice')
  const sourceLabel = desktopScreenShareSourceLabel(source, t)
  const FallbackIcon =
    source.type === 'screen'
      ? MonitorIcon
      : source.type === 'game'
        ? Gamepad2Icon
        : AppWindowIcon

  return (
    <div className="grid min-w-0 gap-2">
      {/* eslint-disable-next-line design/no-lookalike -- source thumbnail card */}
      <button
        type="button"
        aria-label={t('sharePicker.shareAria', { source: sourceLabel })}
        className="group min-w-0 rounded-lg border border-border bg-card p-2 text-left transition-colors hover:border-primary hover:bg-hover disabled:pointer-events-none disabled:opacity-60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/35 focus-visible:outline-none"
        disabled={disabled}
        onClick={onShare}
      >
        <div className="relative aspect-video overflow-hidden rounded-md bg-muted">
          {source.thumbnailDataUrl ? (
            <img
              src={source.thumbnailDataUrl}
              alt=""
              className="size-full object-cover"
              draggable={false}
              loading="lazy"
              decoding="async"
            />
          ) : (
            <div className="grid size-full place-items-center text-muted-foreground">
              <FallbackIcon className="size-8" />
            </div>
          )}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-media-backdrop/60 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            <span
              aria-hidden="true"
              className={buttonVariants({ size: 'sm', variant: 'secondary' })}
            >
              {submitting ? (
                <Spinner data-icon="inline-start" />
              ) : null}
              {t('sharePicker.share')}
            </span>
          </div>
        </div>
      </button>
      <div className="flex min-w-0 items-center gap-2 px-1 pb-1">
        {source.appIconDataUrl ? (
          <img
            src={source.appIconDataUrl}
            alt=""
            className="size-4 shrink-0"
            draggable={false}
            loading="lazy"
            decoding="async"
          />
        ) : (
          <FallbackIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate text-sm font-medium">{sourceLabel}</span>
      </div>
    </div>
  )
}

function ScreenSharePickerQualitySummary() {
  const t = useTranslations('voice')
  const quality = useScreenShareQuality()
  return (
    <div className="mr-auto min-w-0 text-left">
      <p className="text-sm font-semibold text-foreground">
        {t('sharePicker.quality')}
      </p>
      <p className="text-xs text-muted-foreground">
        {quality.resolutionLabel(quality.resolution)} · {quality.fps} FPS
      </p>
    </div>
  )
}

function ScreenSharePickerSettings({
  audioSupported,
  audioRequested,
  onAudioRequestedChange,
  disabled,
}: {
  audioSupported: boolean
  audioRequested: boolean
  onAudioRequestedChange: (value: boolean) => void
  disabled: boolean
}) {
  const t = useTranslations('voice')
  const quality = useScreenShareQuality()
  return (
    <Popover>
      <PopoverTrigger render={<Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={t('sharePicker.streamSettings')}
          title={t('sharePicker.streamSettings')}
          disabled={disabled}
          className="group/gear" />}>
          <Settings2Icon className="size-5 transition-transform duration-500 ease-out group-hover/gear:rotate-90 group-data-[popup-open]/gear:rotate-90 motion-reduce:transition-none" />
        </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="z-420 w-64"
      >
        <div className="flex flex-col gap-0.5">
          <StreamSettingsSubmenu
            label={t('sharePicker.resolution')}
            hint={quality.resolutionLabel(quality.resolution)}
            side="left"
          >
            <ScreenShareResolutionOptions />
          </StreamSettingsSubmenu>
          <StreamSettingsSubmenu
            label={t('sharePicker.frameRate')}
            hint={`${quality.fps} FPS`}
            side="left"
          >
            <ScreenShareFpsOptions />
          </StreamSettingsSubmenu>
          {audioSupported ? (
            <>
              <Separator className="my-0.5" />
              <Item size="xs" render={<label />}>
                <ItemContent>
                  <ItemTitle>{t('sharePicker.muteAudio')}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Checkbox
                    checked={!audioRequested}
                    aria-label={t('sharePicker.muteAudio')}
                    onCheckedChange={(checked) =>
                      onAudioRequestedChange(checked !== true)
                    }
                  />
                </ItemActions>
              </Item>
            </>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
