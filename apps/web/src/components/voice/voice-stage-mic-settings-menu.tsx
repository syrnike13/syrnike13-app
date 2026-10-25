import { useEffect, useMemo, useState } from 'react'
import { ChevronRightIcon, Settings2Icon } from '#/components/icons'
import { Effect, Fiber } from 'effect'
import { useTranslations, type Translator } from '@syrnike13/ui/i18n'

import { Checkbox } from '@syrnike13/ui/primitives/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@syrnike13/ui/primitives/dropdown-menu'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from '@syrnike13/ui/primitives/item'
import { Slider } from '@syrnike13/ui/primitives/slider'
import { VoicePopoverRow } from '#/components/voice/voice-popover-rows'
import { Separator } from '@syrnike13/ui/primitives/separator'
import {
  deviceLabel,
  selectableDevices,
  systemDefaultDevice,
} from '#/components/voice/voice-device-list'
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

function resolveSelectedDeviceLabel(
  devices: MediaDeviceInfo[],
  preferredId: string | undefined,
  t: Translator,
) {
  if (!preferredId) {
    const fallback = systemDefaultDevice(devices)
    return fallback
      ? t('devices.defaultDevice', { name: deviceLabel(fallback, t) })
      : t('devices.default')
  }
  const match = selectableDevices(devices).find(
    (device) => device.deviceId === preferredId,
  )
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
      <p className="text-xs font-semibold text-foreground">
        {t('devices.micLevel')}
      </p>
      <MicInputMeter levels={levels} />
      <p className="text-xs text-muted-foreground">
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

      <MicSettingsSeparator />

      <VoicePopoverRow
        label={t('devices.voiceSettings')}
        trailing={<Settings2Icon />}
        onClick={() => openSettings('voice')}
      />
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
        <p className="text-xs font-semibold text-foreground">
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

      <Item size="xs" render={<label />}>
        <ItemContent>
          <ItemTitle>{t('devices.dontHear')}</ItemTitle>
        </ItemContent>
        <ItemActions>
          <Checkbox
            checked={prefs.deafened}
            aria-label={t('devices.dontHear')}
            onCheckedChange={() => voice.toggleDeafen()}
          />
        </ItemActions>
      </Item>

      <VoicePopoverRow
        label={t('devices.voiceSettings')}
        trailing={<Settings2Icon />}
        onClick={() => openSettings('voice')}
      />
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

      <MicSettingsSeparator />

      <section className="space-y-2 px-0.5">
        <p className="text-xs font-semibold text-foreground">
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

      <VoicePopoverRow
        label={t('devices.voiceSettings')}
        trailing={<Settings2Icon />}
        onClick={() => openSettings('voice')}
      />
    </div>
  )
}

function MicSettingsSeparator() {
  return <Separator className="my-0.5" />
}

const DEFAULT_DEVICE_VALUE = '__default__'

/** Device row: opens the device list on hover, like Discord. */
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
  const selectable = selectableDevices(devices)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        openOnHover
        delay={50}
        render={<Item size="xs" render={<button type="button" />} />}
      >
        <ItemContent>
          <ItemTitle>{title}</ItemTitle>
          <ItemDescription className="truncate">{subtitle}</ItemDescription>
        </ItemContent>
        <ItemActions className="text-muted-foreground">
          <ChevronRightIcon />
        </ItemActions>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start" sideOffset={6} className="z-420 w-60">
        <DropdownMenuRadioGroup
          value={selectedId ?? DEFAULT_DEVICE_VALUE}
          onValueChange={(value) =>
            onSelect(value === DEFAULT_DEVICE_VALUE ? undefined : value)
          }
        >
          <DropdownMenuRadioItem value={DEFAULT_DEVICE_VALUE}>
            {t('devices.default')}
          </DropdownMenuRadioItem>
          {selectable.map((device) => (
            <DropdownMenuRadioItem key={device.deviceId} value={device.deviceId}>
              <span className="min-w-0 truncate">{deviceLabel(device, t)}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
