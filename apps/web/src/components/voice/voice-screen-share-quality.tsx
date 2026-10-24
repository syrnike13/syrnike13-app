import type { ReactNode } from 'react'
import { useTranslations, type Translator } from '@syrnike13/ui/i18n'
import {
  ChevronRightIcon,
  MonitorUpIcon,
  MonitorXIcon,
} from '#/components/icons'

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@syrnike13/ui/primitives/popover'
import {
  RadioGroup,
} from '@syrnike13/ui/primitives/radio-group'
import { Separator } from '@syrnike13/ui/primitives/separator'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemTitle,
} from '@syrnike13/ui/primitives/item'
import {
  VoicePopoverRadioRow,
  VoicePopoverRow,
  VoicePopoverTitle,
} from '#/components/voice/voice-popover-rows'
import { useVoicePreferences } from '#/features/voice/use-voice-preferences'
import { useVoiceMedia } from '#/features/voice/voice-media-context'
import { voicePreferenceStore } from '#/features/voice/voice-preference-store'
import {
  NATIVE_SCREEN_SHARE_PROFILES,
  nativeScreenShareProfileSettings,
  type NativeScreenShareProfile,
  type ScreenShareQualityName,
} from '#/features/voice/voice-preference-types'
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

export function ScreenShareFpsOptions() {
  const t = useTranslations('voice')
  const quality = useScreenShareQuality()
  return (
    <RadioGroup
      value={String(quality.fps)}
      aria-label={t('sharePicker.frameRate')}
      className="gap-0"
      onValueChange={(next) => {
        const fps = Number(next)
        if (Number.isFinite(fps)) quality.setFps(fps)
      }}
    >
      {quality.fpsValues.map((fps) => (
        <VoicePopoverRadioRow
          key={fps}
          label={t('sharePicker.fpsValue', { fps })}
          value={String(fps)}
        />
      ))}
    </RadioGroup>
  )
}

export function ScreenShareResolutionOptions() {
  const t = useTranslations('voice')
  const quality = useScreenShareQuality()
  return (
    <RadioGroup
      value={quality.resolution}
      aria-label={t('sharePicker.resolution')}
      className="gap-0"
      onValueChange={(next) =>
        quality.setResolution(next as StreamResolution)
      }
    >
      {quality.resolutions.map((resolution) => (
        <VoicePopoverRadioRow
          key={resolution}
          label={quality.resolutionLabel(resolution)}
          value={resolution}
        />
      ))}
    </RadioGroup>
  )
}

/** Обе группы подряд: «Частота кадров» и «Разрешение». */
export function ScreenShareQualitySections() {
  const t = useTranslations('voice')
  return (
    <div className="flex flex-col gap-1">
      <VoicePopoverTitle>{t('sharePicker.frameRate')}</VoicePopoverTitle>
      <ScreenShareFpsOptions />
      <Separator className="my-1" />
      <VoicePopoverTitle>{t('sharePicker.resolution')}</VoicePopoverTitle>
      <ScreenShareResolutionOptions />
    </div>
  )
}

/**
 * Строка меню со вложенным подменю. Подменю — отдельный
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
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={50}
        closeDelay={150}
        render={<Item size="xs" render={<button type="button" />} />}
      >
        <ItemContent>
          <ItemTitle>{label}</ItemTitle>
        </ItemContent>
        <ItemActions className="text-muted-foreground">
          {hint ? <span className="text-xs">{hint}</span> : null}
          <ChevronRightIcon />
        </ItemActions>
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align="start"
        sideOffset={6}
        data-mini-control
        className="z-520 w-60 p-1"
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}

/** Меню под стрелкой у кнопки демонстрации. */
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
    <div className="flex flex-col">
      {sharing ? (
        <>
          <VoicePopoverRow
            label={t('actions.stopStream')}
            icon={<MonitorXIcon />}
            destructive
            onClick={voiceMedia.toggleScreenShare}
          />
          {voiceMedia.changeScreenShareSource ? (
            <VoicePopoverRow
              label={t('actions.changeSource')}
              icon={<MonitorUpIcon />}
              onClick={voiceMedia.changeScreenShareSource}
            />
          ) : null}
          <Separator className="my-0.5" />
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
