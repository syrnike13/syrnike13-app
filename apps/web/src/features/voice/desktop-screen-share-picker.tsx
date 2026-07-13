import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AppWindowIcon,
  CheckIcon,
  Gamepad2Icon,
  Loader2Icon,
  MonitorIcon,
} from '#/components/icons'
import { toast } from 'sonner'
import type {
  DesktopDisplayMediaRequest,
  DesktopDisplayMediaSource,
  DesktopDisplayMediaSourceType,
} from '@syrnike13/platform'

import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { cn } from '#/lib/utils'
import { usePlatform } from '#/platform/use-platform'
import { Switch } from '#/components/ui/switch'
import { rememberDesktopScreenShareBroadcastSource } from '#/features/voice/voice-broadcast-source'

type SourceTab = DesktopDisplayMediaSourceType

const SOURCE_TABS: Array<{
  value: SourceTab
  label: string
  icon: typeof MonitorIcon
}> = [
  { value: 'screen', label: 'Экраны', icon: MonitorIcon },
  { value: 'game', label: 'Игры', icon: Gamepad2Icon },
  { value: 'window', label: 'Окна', icon: AppWindowIcon },
]

const EMPTY_TAB_TEXT: Record<SourceTab, string> = {
  screen: 'Экраны не найдены',
  game: 'Запустите игру с видимым окном',
  window: 'Окна не найдены',
}

function sourceProcessName(source: DesktopDisplayMediaSource) {
  if (!source.processPath) return null
  const normalized = source.processPath.replaceAll('\\', '/')
  return normalized.split('/').at(-1) || null
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
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<SourceTab>('screen')
  const [audioRequested, setAudioRequested] = useState(true)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!desktop) return
    return desktop.media.onRequest((nextRequest) => {
      setRequest(nextRequest)
      setSources([])
      setSelectedSourceId(null)
      setActiveTab('screen')
      setAudioRequested(nextRequest.audioRequested)
      setSubmitting(false)
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
        const preferred =
          nextSources.find((source) => source.type === 'screen') ??
          nextSources[0] ??
          null
        setSelectedSourceId(preferred?.id ?? null)
        setActiveTab(preferred?.type ?? 'screen')
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

  const filteredSources = useMemo(
    () => sources.filter((source) => source.type === activeTab),
    [activeTab, sources],
  )
  const selectedSource = useMemo(
    () => sources.find((source) => source.id === selectedSourceId) ?? null,
    [selectedSourceId, sources],
  )
  const selectedAudioAvailable = canRequestSourceAudio(selectedSource)

  useEffect(() => {
    if (!selectedAudioAvailable && audioRequested) {
      setAudioRequested(false)
    }
  }, [audioRequested, selectedAudioAvailable])

  const cancelRequest = useCallback(() => {
    const activeRequest = request
    setRequest(null)
    setSources([])
    setSelectedSourceId(null)
    setSubmitting(false)
    if (desktop && activeRequest) {
      void desktop.media.cancelRequest(activeRequest.id)
    }
  }, [desktop, request])

  const selectSource = useCallback(async () => {
    if (!desktop || !request || !selectedSourceId) return

    setSubmitting(true)
    try {
      const selected = await desktop.media.selectDisplaySource(
        request.id,
        selectedSourceId,
        audioRequested && selectedAudioAvailable,
      )
      if (!selected) {
        toast.error('Источник демонстрации больше недоступен')
        setSubmitting(false)
        return
      }
      if (selectedSource) {
        rememberDesktopScreenShareBroadcastSource(selectedSource)
      }
      setRequest(null)
      setSources([])
      setSelectedSourceId(null)
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Не удалось начать демонстрацию',
      )
      setSubmitting(false)
    }
  }, [
    audioRequested,
    desktop,
    request,
    selectedAudioAvailable,
    selectedSource,
    selectedSourceId,
  ])

  const open = Boolean(request)

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && cancelRequest()}>
      <DialogContent className="grid max-h-[min(44rem,92vh)] max-w-[min(58rem,94vw)] grid-rows-[auto_auto_1fr_auto] gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 py-4 pr-12 text-left">
          <DialogTitle className="text-base">Демонстрация экрана</DialogTitle>
          <DialogDescription className="sr-only">
            Выберите экран, игру или окно, которое хотите показать участникам
            голосового канала.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-1 border-b border-border bg-muted/20 px-4 py-2">
          {SOURCE_TABS.map((tab) => {
            const Icon = tab.icon
            const count = sources.filter((source) => source.type === tab.value)
              .length
            return (
              <button
                key={tab.value}
                type="button"
                className={cn(
                  'inline-flex h-8 items-center gap-2 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                  activeTab === tab.value && 'bg-accent text-foreground',
                )}
                onClick={() => setActiveTab(tab.value)}
              >
                <Icon className="size-4" />
                <span>{tab.label}</span>
                <span className="text-xs text-muted-foreground">{count}</span>
              </button>
            )
          })}
        </div>

        <div className="min-h-0 overflow-y-auto px-4 py-4">
          {loading ? (
            <div className="grid min-h-64 place-items-center text-muted-foreground">
              <Loader2Icon className="size-6 animate-spin" />
            </div>
          ) : filteredSources.length > 0 ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-3">
              {filteredSources.map((source) => (
                <DisplaySourceTile
                  key={source.id}
                  source={source}
                  selected={source.id === selectedSourceId}
                  onSelect={() => setSelectedSourceId(source.id)}
                />
              ))}
            </div>
          ) : (
            <div className="grid min-h-64 place-items-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
              {EMPTY_TAB_TEXT[activeTab]}
            </div>
          )}
        </div>

        <DialogFooter className="flex-row items-center justify-between border-t border-border px-4 py-3">
          {request?.nativeVideo ? (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Switch
                checked={audioRequested}
                onCheckedChange={setAudioRequested}
                disabled={submitting || !selectedAudioAvailable}
              />
              <span>Звук</span>
            </label>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={cancelRequest}
              disabled={submitting}
            >
              Отмена
            </Button>
            <Button
              type="button"
              onClick={() => void selectSource()}
              disabled={!selectedSourceId || submitting}
            >
              {submitting ? <Loader2Icon className="size-4 animate-spin" /> : null}
              Поделиться
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DisplaySourceTile({
  source,
  selected,
  onSelect,
}: {
  source: DesktopDisplayMediaSource
  selected: boolean
  onSelect: () => void
}) {
  const processName = sourceProcessName(source)
  const FallbackIcon =
    source.type === 'screen'
      ? MonitorIcon
      : source.type === 'game'
        ? Gamepad2Icon
        : AppWindowIcon

  return (
    <button
      type="button"
      className={cn(
        'group grid min-w-0 gap-2 rounded-md border border-border bg-card p-2 text-left transition-colors hover:border-ring/70 hover:bg-accent/30 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/35 focus-visible:outline-none',
        selected && 'border-ring bg-accent/40',
      )}
      onClick={onSelect}
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
        {selected ? (
          <span className="absolute top-2 right-2 grid size-6 place-items-center rounded-full bg-primary text-primary-foreground shadow">
            <CheckIcon className="size-4" />
          </span>
        ) : null}
      </div>
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
        <span className="truncate text-sm font-medium">{source.name}</span>
      </div>
      <div className="flex min-w-0 items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
        <span className="truncate">{sourceAudioLabel(source)}</span>
        {processName ? (
          <span className="max-w-24 shrink-0 truncate">{processName}</span>
        ) : null}
      </div>
    </button>
  )
}
