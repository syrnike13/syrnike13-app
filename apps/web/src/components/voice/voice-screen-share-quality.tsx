import { useState, type ReactNode } from 'react'
import {
  ChevronRightIcon,
  MonitorUpIcon,
  MonitorXIcon,
} from '#/components/icons'

import {
  voiceStagePopoverMenuItemClass,
  voiceStagePopoverNavRowClass,
  voiceStagePopoverSeparatorClass,
  voiceStagePopoverSubmenuClass,
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

const RESOLUTION_LABELS: Record<StreamResolution, string> = {
  '540p': '540p',
  '720p': '720p',
  '1080p': '1080p',
  source: 'Источник',
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
      RESOLUTION_LABELS[resolution],
    summary: `${RESOLUTION_LABELS[current.resolution]} · ${current.fps} FPS`,
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
        'flex size-[18px] shrink-0 items-center justify-center rounded-full border-2 transition-colors',
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
        'w-full justify-between gap-3',
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
  const quality = useScreenShareQuality()
  return (
    <div role="group" aria-label="Частота кадров">
      {quality.fpsValues.map((fps) => (
        <RadioRow
          key={fps}
          label={`${fps} кадров в секунду`}
          checked={quality.fps === fps}
          onSelect={() => quality.setFps(fps)}
        />
      ))}
    </div>
  )
}

export function ScreenShareResolutionOptions() {
  const quality = useScreenShareQuality()
  return (
    <div role="group" aria-label="Разрешение">
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
  return (
    <div className="flex flex-col">
      <SectionTitle>Частота кадров</SectionTitle>
      <ScreenShareFpsOptions />
      <div className={cn(voiceStagePopoverSeparatorClass, 'my-1.5')} />
      <SectionTitle>Разрешение</SectionTitle>
      <ScreenShareResolutionOptions />
    </div>
  )
}

/** Строка меню со вложенным подменю справа или слева (как в Discord). */
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
  return (
    <div className="relative" onPointerLeave={() => setOpen(false)}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(voiceStagePopoverNavRowClass, open && 'bg-accent/70')}
        onPointerEnter={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {hint ? (
          <span className="shrink-0 text-xs text-muted-foreground">{hint}</span>
        ) : null}
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
      </button>
      {open ? (
        <div
          role="menu"
          className={cn(
            voiceStagePopoverSubmenuClass,
            side === 'left' && 'right-full left-auto mr-1 ml-0',
          )}
          onPointerEnter={() => setOpen(true)}
        >
          {children}
        </div>
      ) : null}
    </div>
  )
}

/** Меню под стрелкой у кнопки демонстрации (как в Discord). */
export function VoiceStreamSettingsMenuContent({
  submenuSide = 'right',
}: {
  submenuSide?: 'left' | 'right'
}) {
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
            <span>Прекратить стрим</span>
          </button>
          {voiceMedia.changeScreenShareSource ? (
            <button
              type="button"
              className={cn(voiceStagePopoverMenuItemClass, 'w-full gap-2')}
              onClick={voiceMedia.changeScreenShareSource}
            >
              <MonitorUpIcon className="size-4 shrink-0" />
              <span>Изменить источник</span>
            </button>
          ) : null}
          <div className={voiceStagePopoverSeparatorClass} role="separator" />
        </>
      ) : null}
      <StreamSettingsSubmenu
        label="Качество передачи"
        hint={quality.summary}
        side={submenuSide}
      >
        <ScreenShareQualitySections />
      </StreamSettingsSubmenu>
    </div>
  )
}
