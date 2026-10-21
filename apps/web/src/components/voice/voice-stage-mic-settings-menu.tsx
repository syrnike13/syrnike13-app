import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRightIcon, Settings2Icon } from '#/components/icons'
import { Effect, Fiber } from 'effect'
import { useTranslations, type Translator } from '@syrnike13/ui/i18n'

import { Checkbox } from '@syrnike13/ui/primitives/checkbox'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@syrnike13/ui/primitives/popover'
import {
  RadioGroup,
  RadioGroupItem,
} from '@syrnike13/ui/primitives/radio-group'
import { Slider } from '@syrnike13/ui/primitives/slider'
import { Separator } from '@syrnike13/ui/primitives/separator'
import {
  voiceStagePopoverContentClass,
  voiceStagePopoverHintClass,
  voiceStagePopoverMenuItemClass,
  voiceStagePopoverNavRowClass,
  voiceStagePopoverSectionTitleClass,
} from '#/components/voice/voice-stage-popover-styles'
import { useAuth } from '#/features/auth/auth-context'
import { useSettingsModal } from '#/features/settings/settings-modal-context'
import {
  ensureMediaDevicePermissionEffect,
  useMediaDevices,
} from '#/features/voice/use-media-devices'
import { useVoicePreferences } from '#/features/voice/use-voice-preferences'
import { useVoiceSession } from '#/features/voice/voice-session-context'
import {
  VOICE_OUTPUT_VOLUME_MAX,
  voicePreferenceStore,
} from '#/features/voice/voice-preference-store'
import type { CSSVars } from '#/lib/css-vars'
import { cn } from '#/lib/utils'

const METER_BAR_COUNT = 25

function deviceLabel(device: MediaDeviceInfo, t: Translator) {
  return device.label.trim() || t('devices.device')
}

function resolveSelectedDeviceLabel(
  devices: MediaDeviceInfo[],
  preferredId: string | undefined,
  t: Translator,
) {
  const selectable = devices.filter((device) => device.deviceId.length > 0)
  if (!preferredId) {
    const first = selectable[0]
    return first
      ? t('devices.defaultDevice', { name: deviceLabel(first, t) })
      : t('devices.default')
  }
  const match = selectable.find((device) => device.deviceId === preferredId)
  return match ? deviceLabel(match, t) : t('devices.device')
}

function outputVolumeToSlider(outputVolume: number) {
  return Math.round((outputVolume / VOICE_OUTPUT_VOLUME_MAX) * 100)
}

function sliderToOutputVolume(value: number) {
  return Number(((value / 100) * VOICE_OUTPUT_VOLUME_MAX).toFixed(2))
}

function useMicInputSettingsModel() {
  const t = useTranslations('voice')
  const prefs = useVoicePreferences()
  const voice = useVoiceSession()
  const auth = useAuth()
  const inputDevices = useMediaDevices('audioinput')
  const [meterLevels, setMeterLevels] = useState(() =>
    Array.from({ length: METER_BAR_COUNT }, () => 0),
  )

  useEffect(() => {
    const fiber = Effect.runFork(
      ensureMediaDevicePermissionEffect('audio').pipe(Effect.ignore),
    )
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [])

  const inputSubtitle = useMemo(
    () =>
      resolveSelectedDeviceLabel(
        inputDevices,
        prefs.preferredAudioInputDevice,
        t,
      ),
    [inputDevices, prefs.preferredAudioInputDevice, t],
  )

  const selfSpeaking =
    auth.user?._id != null && voice.speakingUserIds.has(auth.user._id)

  useEffect(() => {
    let frame = 0
    const tick = () => {
      setMeterLevels((current) =>
        current.map((level, index) => {
          const target = selfSpeaking
            ? 0.25 + Math.random() * 0.75 * ((index % 5) + 1) / 5
            : 0.04 + Math.random() * 0.03
          return level * 0.55 + target * 0.45
        }),
      )
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [selfSpeaking])

  return {
    prefs,
    voice,
    inputDevices,
    inputSubtitle,
    meterLevels,
  }
}

function MicInputDeviceSettingsRows({
  inputDevices,
  inputSubtitle,
  preferredAudioInputDevice,
}: {
  inputDevices: MediaDeviceInfo[]
  inputSubtitle: string
  preferredAudioInputDevice: string | undefined
}) {
  const t = useTranslations('voice')

  return (
    <MicSettingsDeviceRow
      title={t('devices.microphone')}
      subtitle={inputSubtitle}
      devices={inputDevices}
      selectedId={preferredAudioInputDevice}
      onSelect={(deviceId) => {
        voicePreferenceStore.setPreferredAudioInputDevice(deviceId)
      }}
    />
  )
}

function MicInputMeterSection({
  levels,
}: {
  levels: readonly number[]
}) {
  const t = useTranslations('voice')

  return (
    <section className="space-y-2 px-0.5">
      <p className={voiceStagePopoverSectionTitleClass}>
        {t('devices.micLevel')}
      </p>
      <MicInputMeter levels={levels} />
      <p className={voiceStagePopoverHintClass}>
        {t('devices.micLevelHint')}
      </p>
    </section>
  )
}

/** UserPanel: устройство и профиль входа. */
export function VoicePanelMicSettingsMenuContent() {
  const t = useTranslations('voice')
  const { prefs, inputDevices, inputSubtitle } = useMicInputSettingsModel()
  const { openSettings } = useSettingsModal()

  return (
    <div className="flex flex-col gap-2">
      <MicInputDeviceSettingsRows
        inputDevices={inputDevices}
        inputSubtitle={inputSubtitle}
        preferredAudioInputDevice={prefs.preferredAudioInputDevice}
      />

      <button
        type="button"
        className={cn(
          voiceStagePopoverMenuItemClass,
          'justify-between',
        )}
        onClick={() => openSettings('voice')}
      >
        <span>{t('devices.voiceSettings')}</span>
        <Settings2Icon className="size-4 shrink-0 text-muted-foreground" />
      </button>
    </div>
  )
}

/** Оверлей стейджа: полное меню микрофона и звука. */
export function VoiceStageMicSettingsMenuContent() {
  const t = useTranslations('voice')
  const { prefs, voice, inputDevices, inputSubtitle, meterLevels } =
    useMicInputSettingsModel()
  const { openSettings } = useSettingsModal()
  const outputDevices = useMediaDevices('audiooutput')

  const outputSubtitle = useMemo(
    () =>
      resolveSelectedDeviceLabel(
        outputDevices,
        prefs.preferredAudioOutputDevice,
        t,
      ),
    [outputDevices, prefs.preferredAudioOutputDevice, t],
  )

  return (
    <div className="flex flex-col gap-2">
      <MicInputDeviceSettingsRows
        inputDevices={inputDevices}
        inputSubtitle={inputSubtitle}
        preferredAudioInputDevice={prefs.preferredAudioInputDevice}
      />

      <MicSettingsDeviceRow
        title={t('devices.output')}
        subtitle={outputSubtitle}
        devices={outputDevices}
        selectedId={prefs.preferredAudioOutputDevice}
        onSelect={(deviceId) => {
          voicePreferenceStore.setPreferredAudioOutputDevice(deviceId)
        }}
      />

      <MicSettingsSeparator />

      <MicInputMeterSection levels={meterLevels} />

      <section className="space-y-2 px-0.5">
        <p className={voiceStagePopoverSectionTitleClass}>
          {t('devices.inputVolume')}
        </p>
        <Slider
          value={[outputVolumeToSlider(prefs.outputVolume)]}
          min={0}
          max={100}
          step={1}
          onValueChange={(next) => {
            const value = typeof next === 'number' ? next : next[0]
            if (value == null) return
            voicePreferenceStore.setOutputVolume(sliderToOutputVolume(value))
          }}
        />
      </section>

      <MicSettingsSeparator />

      <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-accent/70">
        <span className={voiceStagePopoverSectionTitleClass}>
          {t('devices.dontHear')}
        </span>
        <Checkbox
          checked={prefs.deafened}
          aria-label={t('devices.dontHear')}
          onCheckedChange={() => voice.toggleDeafen()}
        />
      </label>

      <button
        type="button"
        className={cn(
          voiceStagePopoverMenuItemClass,
          'justify-between',
        )}
        onClick={() => openSettings('voice')}
      >
        <span>{t('devices.voiceSettings')}</span>
        <Settings2Icon className="size-4 shrink-0 text-muted-foreground" />
      </button>
    </div>
  )
}

export function VoiceSoundSettingsMenuContent() {
  const t = useTranslations('voice')
  const prefs = useVoicePreferences()
  const { openSettings } = useSettingsModal()
  const outputDevices = useMediaDevices('audiooutput')

  useEffect(() => {
    const fiber = Effect.runFork(
      ensureMediaDevicePermissionEffect('audio').pipe(Effect.ignore),
    )
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [])

  const outputSubtitle = useMemo(
    () =>
      resolveSelectedDeviceLabel(
        outputDevices,
        prefs.preferredAudioOutputDevice,
        t,
      ),
    [outputDevices, prefs.preferredAudioOutputDevice, t],
  )

  return (
    <div className="flex flex-col gap-2">
      <MicSettingsDeviceRow
        title={t('devices.output')}
        subtitle={outputSubtitle}
        devices={outputDevices}
        selectedId={prefs.preferredAudioOutputDevice}
        onSelect={(deviceId) => {
          voicePreferenceStore.setPreferredAudioOutputDevice(deviceId)
        }}
      />

      <section className="space-y-2 px-0.5">
        <p className={voiceStagePopoverSectionTitleClass}>
          {t('devices.inputVolume')}
        </p>
        <Slider
          value={[outputVolumeToSlider(prefs.outputVolume)]}
          min={0}
          max={100}
          step={1}
          onValueChange={(next) => {
            const value = typeof next === 'number' ? next : next[0]
            if (value == null) return
            voicePreferenceStore.setOutputVolume(sliderToOutputVolume(value))
          }}
        />
      </section>

      <button
        type="button"
        className={cn(
          voiceStagePopoverMenuItemClass,
          'justify-between',
        )}
        onClick={() => openSettings('voice')}
      >
        <span>{t('devices.voiceSettings')}</span>
        <Settings2Icon className="size-4 shrink-0 text-muted-foreground" />
      </button>
    </div>
  )
}

function MicSettingsSeparator() {
  return <Separator className="my-0.5" />
}

const DEFAULT_DEVICE_VALUE = '__default__'

function MicSettingsDeviceRow({
  title,
  subtitle,
  devices,
  selectedId,
  onSelect,
}: {
  title: string
  subtitle: string
  devices: MediaDeviceInfo[]
  selectedId: string | undefined
  onSelect: (deviceId: string | undefined) => void
}) {
  const t = useTranslations('voice')
  const selectable = devices.filter((device) => device.deviceId.length > 0)
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

  function select(value: string) {
    onSelect(value === DEFAULT_DEVICE_VALUE ? undefined : value)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(
              // eslint-disable-next-line shadcn/require-static-classes -- shared voice popover row class
              voiceStagePopoverNavRowClass,
            )}
            onPointerEnter={show}
            onPointerLeave={scheduleClose}
          />
        }
      >
        <span className="min-w-0 flex-1">
          <span className={voiceStagePopoverSectionTitleClass}>{title}</span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {subtitle}
          </span>
        </span>
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={6}
        className={cn(
          // eslint-disable-next-line shadcn/require-static-classes -- shared voice popover class
          voiceStagePopoverContentClass,
          'w-56 p-1',
        )}
        onPointerEnter={cancelClose}
        onPointerLeave={scheduleClose}
      >
        <RadioGroup
          value={selectedId ?? DEFAULT_DEVICE_VALUE}
          aria-label={title}
          className="gap-0.5"
          onValueChange={select}
        >
          <label
            className={cn(
              voiceStagePopoverMenuItemClass,
              'h-8 cursor-pointer justify-between',
            )}
          >
            <span className="min-w-0 flex-1 truncate">
              {t('devices.default')}
            </span>
            <RadioGroupItem
              value={DEFAULT_DEVICE_VALUE}
              aria-label={t('devices.default')}
            />
          </label>
          {selectable.map((device) => (
            <label
              key={device.deviceId}
              className={cn(
                voiceStagePopoverMenuItemClass,
                'h-8 cursor-pointer justify-between',
              )}
            >
              <span className="min-w-0 flex-1 truncate">
                {deviceLabel(device, t)}
              </span>
              <RadioGroupItem
                value={device.deviceId}
                aria-label={deviceLabel(device, t)}
              />
            </label>
          ))}
        </RadioGroup>
      </PopoverContent>
    </Popover>
  )
}

function MicInputMeter({ levels }: { levels: readonly number[] }) {
  return (
    <div className="flex h-6 items-end gap-px" aria-hidden>
      {levels.map((level, index) => (
        <span
          key={index}
          className={cn(
            'h-(--meter-height) w-1 rounded-sm bg-muted motion-height transition-colors duration-75',
            level > 0.35 && 'bg-primary',
            level > 0.12 && level <= 0.35 && 'bg-muted-foreground/50',
          )}
          style={
            {
              '--meter-height': `${Math.max(12, Math.round(level * 100))}%`,
            } as CSSVars
          }
        />
      ))}
    </div>
  )
}
