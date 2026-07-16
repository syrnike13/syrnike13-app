import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AppWindowIcon,
  Gamepad2Icon,
  Loader2Icon,
  MonitorIcon,
} from '#/components/icons'
import { toast } from 'sonner'
import type {
  DesktopDisplayMediaRequest,
  DesktopDisplayMediaSource,
} from '@syrnike13/platform'

import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '#/components/ui/dialog'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '#/components/ui/tabs'
import { usePlatform } from '#/platform/use-platform'
import { Switch } from '#/components/ui/switch'
import {
  desktopScreenShareSourceLabel,
  rememberDesktopScreenShareBroadcastSource,
} from '#/features/voice/voice-broadcast-source'

type SourceTab = 'screen' | 'applications'

const SOURCE_TABS: Array<{
  value: SourceTab
  label: string
  icon: typeof MonitorIcon
}> = [
  { value: 'screen', label: 'Экран', icon: MonitorIcon },
  { value: 'applications', label: 'Приложения', icon: AppWindowIcon },
]

const EMPTY_TAB_TEXT: Record<SourceTab, string> = {
  screen: 'Экраны не найдены',
  applications: 'Приложения не найдены',
}

export function sourceAudioLabel(source: DesktopDisplayMediaSource) {
  if (source.audioAvailable === false) return 'Звук недоступен'
  if (source.type === 'screen') return 'Системный звук без приложения'
  if (source.type === 'game') return 'Звук только игры'
  return 'Звук только окна'
}

export function canRequestSourceAudio(
  source: DesktopDisplayMediaSource | null | undefined,
) {
  return source?.audioAvailable !== false
}

export function DesktopScreenSharePicker() {
  const { desktop } = usePlatform()
  const [request, setRequest] = useState<DesktopDisplayMediaRequest | null>(
    null,
  )
  const [sources, setSources] = useState<DesktopDisplayMediaSource[]>([])
  const [activeTab, setActiveTab] = useState<SourceTab>('screen')
  const [audioRequested, setAudioRequested] = useState(true)
  const [loading, setLoading] = useState(false)
  const [submittingSourceId, setSubmittingSourceId] = useState<string | null>(
    null,
  )

  useEffect(() => {
    if (!desktop) return
    return desktop.media.onRequest((nextRequest) => {
      setRequest(nextRequest)
      setSources([])
      setActiveTab('screen')
      setAudioRequested(nextRequest.audioRequested)
      setSubmittingSourceId(null)
    })
  }, [desktop])

  useEffect(() => {
    if (!desktop || !request) return

    let cancelled = false
    setLoading(true)
    void desktop.media
      .getDisplaySources(request.id)
      .then((nextSources) => {
        if (cancelled) return
        setSources(nextSources)
        setActiveTab(
          nextSources.some((source) => source.type === 'screen')
            ? 'screen'
            : 'applications',
        )
      })
      .catch((error) => {
        if (cancelled) return
        toast.error(
          error instanceof Error
            ? error.message
            : 'Не удалось получить источники демонстрации',
        )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [desktop, request])

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
    setSubmittingSourceId(null)
    if (desktop && activeRequest) {
      void desktop.media.cancelRequest(activeRequest.id)
    }
  }, [desktop, request])

  const selectSource = useCallback(
    async (source: DesktopDisplayMediaSource) => {
      if (!desktop || !request) return

      setSubmittingSourceId(source.id)
      try {
        const selected = await desktop.media.selectDisplaySource(
          request.id,
          source.id,
          audioRequested && canRequestSourceAudio(source),
        )
        if (!selected) {
          toast.error('Источник демонстрации больше недоступен')
          setSubmittingSourceId(null)
          return
        }
        rememberDesktopScreenShareBroadcastSource(source)
        setRequest(null)
        setSources([])
        setSubmittingSourceId(null)
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : 'Не удалось начать демонстрацию',
        )
        setSubmittingSourceId(null)
      }
    },
    [audioRequested, desktop, request],
  )

  const open = Boolean(request)
  const submitting = submittingSourceId !== null

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && cancelRequest()}>
      <DialogContent
        showCloseButton={false}
        className="grid aspect-[4/3] w-[min(96vw,66.667vh)] max-w-none grid-rows-[1fr_auto] gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <DialogTitle className="sr-only">Демонстрация экрана</DialogTitle>
        <DialogDescription className="sr-only">
          Выберите экран или приложение, которое хотите показать участникам
          голосового канала.
        </DialogDescription>

        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as SourceTab)}
          className="min-h-0 gap-0"
        >
          <TabsList className="mt-4 ml-4 w-[calc(100%-5rem)] shrink-0">
            {SOURCE_TABS.map((tab) => {
              const Icon = tab.icon
              const count =
                tab.value === 'screen'
                  ? screenSources.length
                  : applicationSources.length
              return (
                <TabsTrigger key={tab.value} value={tab.value}>
                  <Icon />
                  <span>{tab.label}</span>
                  <span className="text-xs text-muted-foreground">{count}</span>
                </TabsTrigger>
              )
            })}
          </TabsList>

          <TabsContent value="screen" className="min-h-0 overflow-y-auto p-4">
            <DisplaySourceGrid
              sources={screenSources}
              submittingSourceId={submittingSourceId}
              loading={loading}
              emptyText={EMPTY_TAB_TEXT.screen}
              onShare={selectSource}
            />
          </TabsContent>
          <TabsContent
            value="applications"
            className="min-h-0 overflow-y-auto p-4"
          >
            <DisplaySourceGrid
              sources={applicationSources}
              submittingSourceId={submittingSourceId}
              loading={loading}
              emptyText={EMPTY_TAB_TEXT.applications}
              onShare={selectSource}
            />
          </TabsContent>
        </Tabs>

        <DialogFooter className="flex-row items-center justify-between border-t border-border px-4 py-3">
          {request?.nativeVideo ? (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Switch
                checked={audioRequested}
                onCheckedChange={setAudioRequested}
                disabled={submitting}
              />
              <span>Звук</span>
            </label>
          ) : (
            <span />
          )}
          <Button
            type="button"
            variant="ghost"
            onClick={cancelRequest}
            disabled={submitting}
          >
            Отмена
          </Button>
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
        <Loader2Icon className="size-6 animate-spin" />
      </div>
    )
  }

  if (sources.length === 0) {
    return (
      <div className="grid min-h-64 place-items-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
        {emptyText}
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
  const sourceLabel = desktopScreenShareSourceLabel(source)
  const FallbackIcon =
    source.type === 'screen'
      ? MonitorIcon
      : source.type === 'game'
        ? Gamepad2Icon
        : AppWindowIcon

  return (
    <div className="grid min-w-0 gap-2">
      <button
        type="button"
        aria-label={`Демонстрировать ${sourceLabel}`}
        className="group min-w-0 rounded-md border border-border bg-card p-2 text-left transition-colors hover:border-ring/70 hover:bg-accent/30 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/35 focus-visible:outline-none"
        disabled={disabled}
        onClick={onShare}
      >
        <div className="relative aspect-video overflow-hidden rounded bg-muted">
          {source.thumbnailDataUrl ? (
            <img
              src={source.thumbnailDataUrl}
              alt=""
              className="size-full object-cover"
              draggable={false}
            />
          ) : (
            <div className="grid size-full place-items-center text-muted-foreground">
              <FallbackIcon className="size-8" />
            </div>
          )}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/70 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            <Button
              asChild
              size="sm"
              className="bg-foreground text-background"
            >
              <span aria-hidden="true">
                {submitting ? (
                  <Loader2Icon
                    data-icon="inline-start"
                    className="animate-spin"
                  />
                ) : null}
                Демонстрировать
              </span>
            </Button>
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
          />
        ) : (
          <FallbackIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate text-sm font-medium">{sourceLabel}</span>
      </div>
    </div>
  )
}
