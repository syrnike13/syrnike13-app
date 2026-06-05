import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { CheckIcon, ChevronRightIcon, Settings2Icon } from 'lucide-react'

import { Slider } from '#/components/ui/slider'
import {
  voiceStagePopoverCheckboxClass,
  voiceStagePopoverHintClass,
  voiceStagePopoverMenuItemClass,
  voiceStagePopoverNavRowClass,
  voiceStagePopoverSectionTitleClass,
  voiceStagePopoverSeparatorClass,
  voiceStagePopoverSubmenuClass,
} from '#/components/voice/voice-stage-popover-styles'
import { useAuth } from '#/features/auth/auth-context'
import { useSettingsModal } from '#/features/settings/settings-modal-context'
import {
  ensureMediaDevicePermission,
  useMediaDevices,
} from '#/features/voice/use-media-devices'
import { useVoicePreferences } from '#/features/voice/use-voice-preferences'
import { useVoice } from '#/features/voice/voice-provider'
import type { NoiseSuppressionMode } from '#/features/voice/voice-preference-types'
import {
  VOICE_OUTPUT_VOLUME_MAX,
  voicePreferenceStore,
} from '#/features/voice/voice-preference-store'
import { cn } from '#/lib/utils'

const NOISE_SUPPRESSION_OPTIONS: {
  value: NoiseSuppressionMode
  label: string
  description: string
}[] = [
  {
    value: 'browser',
    label: 'Браузер',
    description: 'Стандартное шумоподавление',
  },
  {
    value: 'enhanced',
    label: 'Усиленное',
    description: 'RNNoise — переподключитесь к голосу',
  },
  {
    value: 'disabled',
    label: 'Выключено',
    description: 'Без обработки',
  },
]

const METER_BAR_COUNT = 25

function deviceLabel(device: MediaDeviceInfo) {
  return device.label.trim() || 'Устройство'
}

function resolveSelectedDeviceLabel(
  devices: MediaDeviceInfo[],
  preferredId: string | undefined,
) {
  const selectable = devices.filter((device) => device.deviceId.length > 0)
  if (!preferredId) {
    const first = selectable[0]
    return first ? `По умолчанию (${deviceLabel(first)})` : 'По умолчанию'
  }
  const match = selectable.find((device) => device.deviceId === preferredId)
  return match ? deviceLabel(match) : 'Устройство'
}

function outputVolumeToSlider(outputVolume: number) {
  return Math.round((outputVolume / VOICE_OUTPUT_VOLUME_MAX) * 100)
}

function sliderToOutputVolume(value: number) {
  return Number(((value / 100) * VOICE_OUTPUT_VOLUME_MAX).toFixed(2))
}

export function VoiceStageMicSettingsMenuContent() {
  const prefs = useVoicePreferences()
  const voice = useVoice()
  const auth = useAuth()
  const { openSettings } = useSettingsModal()
  const inputDevices = useMediaDevices('audioinput')
  const outputDevices = useMediaDevices('audiooutput')
  const [meterLevels, setMeterLevels] = useState(() =>
    Array.from({ length: METER_BAR_COUNT }, () => 0),
  )

  useEffect(() => {
    void ensureMediaDevicePermission('audio')
  }, [])

  const inputSubtitle = useMemo(
    () =>
      resolveSelectedDeviceLabel(
        inputDevices,
        prefs.preferredAudioInputDevice,
      ),
    [inputDevices, prefs.preferredAudioInputDevice],
  )

  const outputSubtitle = useMemo(
    () =>
      resolveSelectedDeviceLabel(
        outputDevices,
        prefs.preferredAudioOutputDevice,
      ),
    [outputDevices, prefs.preferredAudioOutputDevice],
  )

  const profileSubtitle =
    NOISE_SUPPRESSION_OPTIONS.find(
      (option) => option.value === prefs.noiseSuppression,
    )?.label ?? 'Браузер'

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

  return (
    <div className="flex flex-col gap-2">
      <MicSettingsDeviceRow
        title="Микрофон"
        subtitle={inputSubtitle}
        devices={inputDevices}
        selectedId={prefs.preferredAudioInputDevice}
        onSelect={(deviceId) => {
          voicePreferenceStore.setPreferredAudioInputDevice(deviceId)
        }}
      />

      <MicSettingsProfileRow
        subtitle={profileSubtitle}
        selected={prefs.noiseSuppression}
        onSelect={(mode) => {
          voicePreferenceStore.setNoiseSuppression(mode)
        }}
      />

      <MicSettingsDeviceRow
        title="Вывод"
        subtitle={outputSubtitle}
        devices={outputDevices}
        selectedId={prefs.preferredAudioOutputDevice}
        onSelect={(deviceId) => {
          voicePreferenceStore.setPreferredAudioOutputDevice(deviceId)
        }}
      />

      <MicSettingsSeparator />

      <section className="space-y-2 px-0.5">
        <p className={voiceStagePopoverSectionTitleClass}>Уровень микрофона</p>
        <MicInputMeter levels={meterLevels} />
        <p className={voiceStagePopoverHintClass}>
          Громкость входа задаётся в системе. Здесь — индикатор активности.
        </p>
      </section>

      <section className="space-y-2 px-0.5">
        <p className={voiceStagePopoverSectionTitleClass}>
          Громкость входящего
        </p>
        <Slider
          value={[outputVolumeToSlider(prefs.outputVolume)]}
          min={0}
          max={100}
          step={1}
          onValueChange={([value]) => {
            if (value == null) return
            voicePreferenceStore.setOutputVolume(sliderToOutputVolume(value))
          }}
        />
      </section>

      <MicSettingsSeparator />

      <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-accent/70">
        <span className={voiceStagePopoverSectionTitleClass}>Не слышать</span>
        <input
          type="checkbox"
          className={voiceStagePopoverCheckboxClass}
          checked={prefs.deafened}
          onChange={() => voice.toggleDeafen()}
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
        <span>Настройки голоса</span>
        <Settings2Icon className="size-4 shrink-0 text-muted-foreground" />
      </button>
    </div>
  )
}

function MicSettingsSeparator() {
  return <div className={voiceStagePopoverSeparatorClass} role="separator" />
}

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
  const selectable = devices.filter((device) => device.deviceId.length > 0)

  return (
    <MicSettingsSubmenu
      trigger={
        <>
          <span className="min-w-0 flex-1">
            <span className={voiceStagePopoverSectionTitleClass}>{title}</span>
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
              {subtitle}
            </span>
          </span>
          <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
        </>
      }
    >
      <button
        type="button"
        className={micSettingsMenuItemClass(!selectedId)}
        onClick={() => onSelect(undefined)}
      >
        <span className="min-w-0 flex-1 truncate">По умолчанию</span>
        {!selectedId ? (
          <CheckIcon className="size-4 shrink-0 text-primary" />
        ) : (
          <span className="size-4 shrink-0" aria-hidden />
        )}
      </button>
      {selectable.map((device) => {
        const selected = selectedId === device.deviceId
        return (
          <button
            key={device.deviceId}
            type="button"
            className={micSettingsMenuItemClass(selected)}
            onClick={() => onSelect(device.deviceId)}
          >
            <span className="min-w-0 flex-1 truncate">
              {deviceLabel(device)}
            </span>
            {selected ? (
              <CheckIcon className="size-4 shrink-0 text-primary" />
            ) : (
              <span className="size-4 shrink-0" aria-hidden />
            )}
          </button>
        )
      })}
    </MicSettingsSubmenu>
  )
}

function MicSettingsProfileRow({
  subtitle,
  selected,
  onSelect,
}: {
  subtitle: string
  selected: NoiseSuppressionMode
  onSelect: (mode: NoiseSuppressionMode) => void
}) {
  return (
    <MicSettingsSubmenu
      trigger={
        <>
          <span className="min-w-0 flex-1">
            <span className={voiceStagePopoverSectionTitleClass}>
              Профиль входа
            </span>
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
              {subtitle}
            </span>
          </span>
          <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
        </>
      }
    >
      {NOISE_SUPPRESSION_OPTIONS.map((option) => {
        const isSelected = option.value === selected
        return (
          <button
            key={option.value}
            type="button"
            className={cn(micSettingsMenuItemClass(isSelected), 'h-auto items-start py-2')}
            onClick={() => onSelect(option.value)}
          >
            <span className="min-w-0 flex-1 text-left">
              <span className="block truncate text-sm text-foreground">
                {option.label}
              </span>
              <span className={cn('mt-0.5 block', voiceStagePopoverHintClass)}>
                {option.description}
              </span>
            </span>
            {isSelected ? (
              <CheckIcon className="mt-0.5 size-4 shrink-0 text-primary" />
            ) : (
              <span className="mt-0.5 size-4 shrink-0" aria-hidden />
            )}
          </button>
        )
      })}
    </MicSettingsSubmenu>
  )
}

function MicSettingsSubmenu({
  trigger,
  children,
}: {
  trigger: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative" onPointerLeave={() => setOpen(false)}>
      <button
        type="button"
        className={voiceStagePopoverNavRowClass}
        onPointerEnter={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {trigger}
      </button>
      {open ? (
        <div
          className={voiceStagePopoverSubmenuClass}
          onPointerEnter={() => setOpen(true)}
        >
          {children}
        </div>
      ) : null}
    </div>
  )
}

function micSettingsMenuItemClass(selected: boolean) {
  return cn(voiceStagePopoverMenuItemClass, selected && 'bg-accent/60')
}

function MicInputMeter({ levels }: { levels: readonly number[] }) {
  return (
    <div className="flex h-6 items-end gap-px" aria-hidden>
      {levels.map((level, index) => (
        <span
          key={index}
          className={cn(
            'w-1 rounded-sm bg-muted transition-[height,background-color] duration-75',
            level > 0.35 && 'bg-primary',
            level > 0.12 && level <= 0.35 && 'bg-muted-foreground/50',
          )}
          style={{
            height: `${Math.max(12, Math.round(level * 100))}%`,
          }}
        />
      ))}
    </div>
  )
}
