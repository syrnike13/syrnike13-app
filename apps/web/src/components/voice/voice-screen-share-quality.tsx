import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslations, type Translator } from '@syrnike13/ui/i18n'
import {
  ChevronRightIcon,
  MonitorUpIcon,
  MonitorXIcon,
} from '#/components/icons'

import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@syrnike13/ui/primitives/popover'
import {
  voiceStagePopoverContentClass,
  voiceStagePopoverMenuItemClass,
  voiceStagePopoverNavRowClass,
  voiceStagePopoverSeparatorClass,
} from '#/components/voice/voice-stage-popover-styles'
import { useVoicePreferences } from '#/features/voice/use-voice-preferences'
import { useVoiceMedia } from '#/features/voice/voice-media-context'
import { voicePreferenceStore } from '#/features/voice/voice-preference-store'
import {
  NATIVE_SCREEN_SHARE_PROFILES,
  nativeScreenShareProfileSettings,
  type NativeScreenShareProfile,
  type ScreenShareQualityName,
} from '#/features/voice/voice-preference-types'
import { cn } from '#/lib/utils'
import { usePlatform } from '#/platform/use-platform'

type StreamResolution = '540p' | '720p' | '1080p' | 'source'

type QualityCombo =
  | {
      kind: 'native'
      key: NativeScreenShareProfile
      resolution: StreamResolution
      fps: number
    }
  | {
      kind: 'browser'
      key: ScreenShareQualityName
      resolution: StreamResolution
      fps: number
    }

const RESOLUTION_ORDER: readonly StreamResolution[] = [
  '540p',
  '720p',
  '1080p',
  'source',
]

const RESOLUTION_LABELS: Record<Exclude<StreamResolution, 'source'>, string> =
  {
    '540p': '540p',
    '720p': '720p',
    '1080p': '1080p',
  }

function resolutionLabel(resolution: StreamResolution, t: Translator) {
  return resolution === 'source'
    ? t('sharePicker.source')
    : RESOLUTION_LABELS[resolution]
}

const NATIVE_COMBOS: readonly QualityCombo[] = NATIVE_SCREEN_SHARE_PROFILES.map(
  (key) => {
    const settings = nativeScreenShareProfileSettings(key)
    return {
      kind: 'native',
      key,
      resolution: `${settings.height}p` as StreamResolution,
      fps: settings.fps,
    }
  },
)

const BROWSER_COMBOS: readonly QualityCombo[] = [
  { kind: 'browser', key: 'low', resolution: '720p', fps: 30 },
  { kind: 'browser', key: 'high', resolution: '1080p', fps: 30 },
  { kind: 'browser', key: 'high60', resolution: '1080p', fps: 60 },
  { kind: 'browser', key: 'text', resolution: 'source', fps: 5 },
]

function resolutionIndex(resolution: StreamResolution) {
  return RESOLUTION_ORDER.indexOf(resolution)
}

function closest<T>(items: readonly T[], distance: (item: T) => number) {
  return items.reduce((best, item) =>
    distance(item) < distance(best) ? item : best,
  )
}

/**
 * Разрешение и частота кадров своего стрима поверх уже существующих
 * профилей качества. Если точного сочетания нет (например 540p · 60),
 * выбирается ближайшее доступное.
 */
export function useScreenShareQuality() {
  const t = useTranslations('voice')
  const { capabilities } = usePlatform()
  const prefs = useVoicePreferences()
  const native = capabilities.nativeScreenShare
  const combos = native ? NATIVE_COMBOS : BROWSER_COMBOS
  const currentKey = native
    ? prefs.nativeScreenShareProfile
    : prefs.screenShareQuality
  const current = combos.find((combo) => combo.key === currentKey) ?? combos[0]

  const resolutions = RESOLUTION_ORDER.filter((resolution) =>
    combos.some((combo) => combo.resolution === resolution),
  )
  const fpsValues = [...new Set(combos.map((combo) => combo.fps))].sort(
    (a, b) => a - b,
  )

  const select = (combo: QualityCombo) => {
    if (combo.kind === 'native') {
      voicePreferenceStore.setNativeScreenShareProfile(combo.key)
    } else {
      voicePreferenceStore.setScreenShareQuality(combo.key)
    }
  }

  return {
    resolution: current.resolution,
    fps: current.fps,
    resolutions,
    fpsValues,
    resolutionLabel: (resolution: StreamResolution) =>
      resolutionLabel(resolution, t),
    summary: `${resolutionLabel(current.resolution, t)} · ${current.fps} FPS`,
    setResolution: (resolution: StreamResolution) => {
      const candidates = combos.filter(
        (combo) => combo.resolution === resolution,
      )
      if (candidates.length === 0) return
      select(closest(candidates, (combo) => Math.abs(combo.fps - current.fps)))
    },
    setFps: (fps: number) => {
      const candidates = combos.filter((combo) => combo.fps === fps)
      if (candidates.length === 0) return
      select(
        closest(candidates, (combo) =>
          Math.abs(
            resolutionIndex(combo.resolution) -
              resolutionIndex(current.resolution),
          ),
        ),
      )
    },
  }
}

function RadioMark({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex -[1.125rem] shrink-0 items-center justify-center rounded-full border-2 transition-colors',
        checked ? 'border-primary' : 'border-muted-foreground/60',
      )}
    >
      {checked ? <span className="size-2 rounded-full bg-primary" /> : null}
    </span>
  )
}

function RadioRow({
  label,
  checked,
  onSelect,
}: {
  label: string
  checked: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      className={cn(
        voiceStagePopoverMenuItemClass,
        'w-full cursor-pointer justify-between gap-3',
      )}
      onClick={onSelect}
    >
      <span className="min-w-0 truncate">{label}</span>
      <RadioMark checked={checked} />
    </button>
  )
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">
      {children}
    </p>
  )
}

export function ScreenShareFpsOptions() {
  const t = useTranslations('voice')
  const quality = useScreenShareQuality()
  return (
    <div role="group" aria-label={t('sharePicker.frameRate')}>
      {quality.fpsValues.map((fps) => (
        <RadioRow
          key={fps}
          label={t('sharePicker.fpsValue', { fps })}
          checked={quality.fps === fps}
          onSelect={() => quality.setFps(fps)}
        />
      ))}
    </div>
  )
}

export function ScreenShareResolutionOptions() {
  const t = useTranslations('voice')
  const quality = useScreenShareQuality()
  return (
    <div role="group" aria-label={t('sharePicker.resolution')}>
      {quality.resolutions.map((resolution) => (
        <RadioRow
          key={resolution}
          label={quality.resolutionLabel(resolution)}
          checked={quality.resolution === resolution}
          onSelect={() => quality.setResolution(resolution)}
        />
      ))}
    </div>
  )
}

/** Обе группы подряд: «Частота кадров» и «Разрешение». */
export function ScreenShareQualitySections() {
  const t = useTranslations('voice')
  return (
    <div className="flex flex-col">
      <SectionTitle>{t('sharePicker.frameRate')}</SectionTitle>
      <ScreenShareFpsOptions />
      <div className={cn(voiceStagePopoverSeparatorClass, 'my-1.5')} />
      <SectionTitle>{t('sharePicker.resolution')}</SectionTitle>
      <ScreenShareResolutionOptions />
    </div>
  )
}

/**
 * Строка меню со вложенным подменю (как в Discord). Подменю — отдельный
 * поповер в портале: сам упирается в края окна, не обрезается контейнером.
 */
export function StreamSettingsSubmenu({
  label,
  hint,
  side = 'right',
  children,
}: {
  label: ReactNode
  hint?: ReactNode
  side?: 'left' | 'right'
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelClose = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const scheduleClose = () => {
    cancelClose()
    closeTimer.current = setTimeout(() => setOpen(false), 160)
  }
  useEffect(() => cancelClose, [])
  const show = () => {
    cancelClose()
    setOpen(true)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          className={cn(voiceStagePopoverNavRowClass, open && 'bg-accent/70')}
          onPointerEnter={show}
          onPointerLeave={scheduleClose}
          onFocus={show}
          onClick={show}
        >
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {hint ? (
            <span className="shrink-0 text-xs text-muted-foreground">
              {hint}
            </span>
          ) : null}
          <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverAnchor>
      <PopoverContent
        role="menu"
        side={side}
        align="start"
        sideOffset={6}
        collisionPadding={8}
        data-mini-control
        className={cn(voiceStagePopoverContentClass, 'z-[520] w-60 p-1')}
        onPointerEnter={cancelClose}
        onPointerLeave={scheduleClose}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}

/** Меню под стрелкой у кнопки демонстрации (как в Discord). */
export function VoiceStreamSettingsMenuContent({
  submenuSide = 'right',
}: {
  submenuSide?: 'left' | 'right'
}) {
  const t = useTranslations('voice')
  const voiceMedia = useVoiceMedia()
  const quality = useScreenShareQuality()
  const sharing = voiceMedia.screenShareEnabled || voiceMedia.screenShareStarting
  return (
    <div className="flex flex-col gap-0.5">
      {sharing ? (
        <>
          <button
            type="button"
            className={cn(
              voiceStagePopoverMenuItemClass,
              'w-full gap-2 text-destructive hover:text-destructive',
            )}
            onClick={voiceMedia.toggleScreenShare}
          >
            <MonitorXIcon className="size-4 shrink-0" />
            <span>{t('actions.stopStream')}</span>
          </button>
          {voiceMedia.changeScreenShareSource ? (
            <button
              type="button"
              className={cn(voiceStagePopoverMenuItemClass, 'w-full gap-2')}
              onClick={voiceMedia.changeScreenShareSource}
            >
              <MonitorUpIcon className="size-4 shrink-0" />
              <span>{t('actions.changeSource')}</span>
            </button>
          ) : null}
          <div className={voiceStagePopoverSeparatorClass} role="separator" />
        </>
      ) : null}
      <StreamSettingsSubmenu
        label={t('sharePicker.qualityLabel')}
        hint={quality.summary}
        side={submenuSide}
      >
        <ScreenShareQualitySections />
      </StreamSettingsSubmenu>
    </div>
  )
}
