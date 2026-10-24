import { useEffect, useRef, useState } from 'react'
import { Effect, Fiber, Option, Schema } from 'effect'
import { DesktopCameraProfileSchema } from '@syrnike13/platform'
import { useTranslations } from '@syrnike13/ui/i18n'

import {
  SettingsBlock,
  SettingsRow,
  SettingsToggleRow,
} from '#/components/settings/settings-panels'
import { VoiceGateSensitivityBar } from '#/components/settings/voice-gate-sensitivity-bar'
import { Field, FieldTitle } from '@syrnike13/ui/primitives/field'
import { PresetSlider } from '#/components/ui/preset-slider'
import { Button } from '@syrnike13/ui/primitives/button'
import { Switch } from '@syrnike13/ui/primitives/switch'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@syrnike13/ui/primitives/select'
import {
  ensureMediaDevicePermissionEffect,
  useMediaDevices,
} from '#/features/voice/use-media-devices'
import {
  SCREEN_SHARE_CAPTURE_MODES,
  SCREEN_SHARE_CAPTURE_MODE_LABEL_KEYS,
  SCREEN_SHARE_QUALITY_NAMES,
  SCREEN_SHARE_QUALITY_LABEL_KEYS,
  ScreenShareCaptureModeSchema,
  ScreenShareQualitySchema,
  NativeScreenShareProfileSchema,
  NATIVE_SCREEN_SHARE_PROFILES,
} from '#/features/voice/voice-preference-types'
import { usePlatform } from '#/platform/use-platform'
import { useVoicePreferences } from '#/features/voice/use-voice-preferences'
import {
  VOICE_OUTPUT_VOLUME_MAX,
  voicePreferenceStore,
} from '#/features/voice/voice-preference-store'
import { isAv1ScreenShareSupported } from '#/features/voice/voice-capture'
import { useMicPreviewLoopback } from '#/features/voice/use-mic-preview-loopback'
import { useSelfMonitoringEnded } from '#/features/voice/use-self-monitoring-ended'
import { useVoiceMedia } from '#/features/voice/voice-media-context'
import { useVoiceGateMeter } from '#/features/voice/use-voice-gate-meter'
import type { VoiceGateMetrics } from '#/features/voice/voice-gate-stage'
import {
  DEFAULT_VOICE_GATE_THRESHOLD_DB,
  VOICE_GATE_DB_MIN,
} from '#/features/voice/voice-gate-level'
import type { CSSVars } from '#/lib/css-vars'
import { cn } from '#/lib/utils'

function volumeToSlider(volume: number) {
  return Math.round((volume / VOICE_OUTPUT_VOLUME_MAX) * 100)
}

function sliderToVolume(value: number) {
  return Number(((value / 100) * VOICE_OUTPUT_VOLUME_MAX).toFixed(2))
}

const VOLUME_STOPS = [{ value: 0 }, { value: 100 }] as const

function DeviceSelectField({
  label,
  value,
  devices,
  onChange,
}: {
  label: string
  value: string
  devices: MediaDeviceInfo[]
  onChange: (deviceId: string) => void
}) {
  const ts = useTranslations('settings.voice')
  const selectableDevices = devices.filter((device) => device.deviceId.length > 0)
  const selectValue = value.length > 0 ? value : 'default'
  const unavailable = selectValue !== 'default' &&
    !selectableDevices.some((device) => device.deviceId === selectValue)
  const items = [
    { value: 'default', label: ts('defaultOption') },
    ...(unavailable
      ? [{ value: selectValue, label: ts('deviceUnavailable') }]
      : []),
    ...selectableDevices.map((device) => ({
      value: device.deviceId,
      label: device.label || ts('device'),
    })),
  ]

  return (
    <Field>
      <FieldTitle>{label}</FieldTitle>
      <Select
        items={items}
        value={selectValue}
        onValueChange={(deviceId) => {
          if (deviceId != null) onChange(deviceId)
        }}
      >
        <SelectTrigger aria-label={label} className="w-full">
          <SelectValue placeholder={ts('defaultOption')} />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="default">{ts('defaultOption')}</SelectItem>
            {unavailable ? (
              <SelectItem value={selectValue} disabled>
                {ts('deviceUnavailable')}
              </SelectItem>
            ) : null}
            {selectableDevices.map((device) => (
              <SelectItem key={device.deviceId} value={device.deviceId}>
                {device.label || ts('device')}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  )
}

function VolumeSliderField({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (value: number) => void
}) {
  return (
    <Field>
      <FieldTitle>{label}</FieldTitle>
      <PresetSlider
        stops={VOLUME_STOPS}
        value={volumeToSlider(value)}
        mode="continuous"
        step={1}
        showLabels={false}
        showMarks={false}
        onValueChange={(next) => onChange(sliderToVolume(next))}
        formatValue={(next) => `${next}%`}
        aria-label={label}
      />
    </Field>
  )
}

function MicInputMeter({ levels }: { levels: readonly number[] }) {
  return (
    <div
      className="flex h-8 min-w-0 flex-1 items-end gap-px"
      aria-hidden
    >
      {levels.map((level, index) => (
        <span
          key={index}
          className={cn(
            'min-h-1 h-(--level-height) flex-1 rounded-sm bg-muted motion-height transition-colors duration-75',
            level > 0.35 && 'bg-primary',
            level > 0.12 && level <= 0.35 && 'bg-muted-foreground/50',
          )}
          style={
            {
              '--level-height': `${Math.max(12, Math.round(level * 100))}%`,
            } as CSSVars
          }
        />
      ))}
    </div>
  )
}

export function SettingsVoicePanel() {
  const t = useTranslations('voice')
  const ts = useTranslations('settings.voice')
  const prefs = useVoicePreferences()
  const { capabilities, os } = usePlatform()
  const { selfMonitoringActive, setSelfMonitoringActive } = useVoiceMedia()
  const setSelfMonitoringActiveRef = useRef(setSelfMonitoringActive)
  const inputDevices = useMediaDevices('audioinput')
  const outputDevices = useMediaDevices('audiooutput')
  const cameraDevices = useMediaDevices('videoinput')
  const [micTestActive, setMicTestActive] = useState(false)
  const av1Supported = isAv1ScreenShareSupported()

  useEffect(() => {
    const fiber = Effect.runFork(
      ensureMediaDevicePermissionEffect('audio').pipe(Effect.ignore),
    )
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [])

  useEffect(() => {
    if (!av1Supported && prefs.screenShareCodec === 'av1') {
      voicePreferenceStore.setScreenShareCodec('auto')
    }
  }, [av1Supported, prefs.screenShareCodec])

  useEffect(() => {
    setSelfMonitoringActiveRef.current = setSelfMonitoringActive
  }, [setSelfMonitoringActive])

  useEffect(() => {
    setSelfMonitoringActiveRef.current(micTestActive)
    return () => {
      setSelfMonitoringActiveRef.current(false)
    }
  }, [micTestActive])

  // The deafen button and the desktop hotkey can end the check elsewhere.
  useSelfMonitoringEnded(selfMonitoringActive, () => setMicTestActive(false))

  const inputValue = prefs.preferredAudioInputDevice ?? 'default'
  const outputValue = prefs.preferredAudioOutputDevice ?? 'default'
  const micTestDeviceId =
    inputValue === 'default' ? undefined : inputValue
  const micTestOutputDeviceId =
    outputValue === 'default' ? undefined : outputValue
  const gateMetricsRef = useRef<VoiceGateMetrics>({
    inputDb: VOICE_GATE_DB_MIN,
    thresholdDb: DEFAULT_VOICE_GATE_THRESHOLD_DB,
    open: false,
  })
  const meterLevels = useMicPreviewLoopback(
    micTestActive,
    micTestDeviceId,
    micTestOutputDeviceId,
    gateMetricsRef,
  )
  useVoiceGateMeter(
    !micTestActive,
    micTestDeviceId,
    gateMetricsRef,
  )

  return (
    <div className="space-y-2">
      {os === 'win32' ? (
        <SettingsBlock title={ts('camera')}>
          <DeviceSelectField
            label={ts('cameraDevice')}
            devices={cameraDevices}
            value={prefs.preferredVideoDevice ?? 'default'}
            onChange={(deviceId) => {
              voicePreferenceStore.setPreferredVideoDevice(
                deviceId === 'default' ? undefined : deviceId,
              )
            }}
          />
          <SettingsRow label={ts('videoQuality')}>
            <Select
              items={[
                {
                  value: 'hd720p30',
                  label: t('preferences.quality720p30'),
                },
                {
                  value: 'hd1080p30',
                  label: t('preferences.quality1080p30'),
                },
              ]}
              value={prefs.cameraProfile}
              onValueChange={(value) => {
                const profile = Schema.decodeUnknownOption(
                  DesktopCameraProfileSchema,
                )(value)
                if (Option.isSome(profile)) {
                  voicePreferenceStore.setCameraProfile(profile.value)
                }
              }}
            >
              <SelectTrigger
                aria-label={ts('cameraQualityAria')}
                className="w-55 max-w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="hd720p30">
                    {t('preferences.quality720p30')}
                  </SelectItem>
                  <SelectItem value="hd1080p30">
                    {t('preferences.quality1080p30')}
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsBlock>
      ) : null}
      <SettingsBlock title={ts('devices')}>
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div className="space-y-4">
            <DeviceSelectField
              label={ts('microphone')}
              devices={inputDevices}
              value={inputValue}
              onChange={(deviceId) => {
                voicePreferenceStore.setPreferredAudioInputDevice(
                  deviceId === 'default' ? undefined : deviceId,
                )
              }}
            />
            <VolumeSliderField
              label={ts('micVolume')}
              value={prefs.inputVolume}
              onChange={(value) => {
                voicePreferenceStore.setInputVolume(value)
              }}
            />
          </div>

          <div className="space-y-4">
            <DeviceSelectField
              label={ts('speakers')}
              devices={outputDevices}
              value={outputValue}
              onChange={(deviceId) => {
                voicePreferenceStore.setPreferredAudioOutputDevice(
                  deviceId === 'default' ? undefined : deviceId,
                )
              }}
            />
            <VolumeSliderField
              label={ts('volume')}
              value={prefs.outputVolume}
              onChange={(value) => {
                voicePreferenceStore.setOutputVolume(value)
              }}
            />
          </div>

          <div className="col-span-full pt-1">
            <div className="flex items-center gap-3">
              <Button
                type="button"
                size="sm"
                variant={micTestActive ? 'secondary' : 'default'}
                className="shrink-0"
                onClick={() => setMicTestActive((value) => !value)}
              >
                {micTestActive ? ts('stop') : ts('testMic')}
              </Button>
              <MicInputMeter levels={meterLevels} />
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              {micTestActive
                ? ts('micTestActiveHint')
                : ts('micTestHint')}
            </p>
          </div>
        </div>
      </SettingsBlock>

      <SettingsBlock title={ts('processing')}>
        {os === 'win32' ? (
          <SettingsToggleRow
            label={ts('bypassProcessing')}
            hint={ts('bypassProcessingHint')}
            checked={prefs.bypassSystemAudioInputProcessing}
            onCheckedChange={(checked) =>
              voicePreferenceStore.setBypassSystemAudioInputProcessing(checked)
            }
          />
        ) : null}

        <SettingsToggleRow
          label={ts('agc')}
          hint={ts('agcHint')}
          checked={prefs.automaticGainControl}
          onCheckedChange={(checked) =>
            voicePreferenceStore.setAutomaticGainControl(checked)
          }
        />

        <SettingsRow
          label={ts('autoSensitivity')}
          hint={ts('autoSensitivityHint')}
        >
          <Switch
            checked={prefs.voiceGateAutoThreshold}
            onCheckedChange={(checked) =>
              voicePreferenceStore.setVoiceGateAutoThreshold(checked)
            }
          />
        </SettingsRow>

        <div className="pb-2">
          <VoiceGateSensitivityBar
            metricsRef={gateMetricsRef}
            thresholdDb={prefs.voiceGateThresholdDb}
            auto={prefs.voiceGateAutoThreshold}
            onThresholdChange={(thresholdDb) =>
              voicePreferenceStore.setVoiceGateThresholdDb(thresholdDb)
            }
          />
        </div>

        <SettingsToggleRow
          label={ts('noiseSuppression')}
          checked={prefs.noiseSuppression}
          onCheckedChange={(checked) =>
            voicePreferenceStore.setNoiseSuppression(checked)
          }
        />

        <SettingsToggleRow
          label={ts('echoCancellation')}
          checked={prefs.echoCancellation}
          onCheckedChange={(checked) =>
            voicePreferenceStore.setEchoCancellation(checked)
          }
        />
      </SettingsBlock>

      <SettingsBlock title={ts('screenShare')}>
        <SettingsRow label={ts('defaultQuality')}>
          {capabilities.nativeScreenShare ? (
            <Select
              items={NATIVE_SCREEN_SHARE_PROFILES.map((profile) => ({
                value: profile,
                label: t(`preferences.quality${profile}`),
              }))}
              value={prefs.nativeScreenShareProfile}
              onValueChange={(value) => {
                const profile = Schema.decodeUnknownOption(
                  NativeScreenShareProfileSchema,
                )(value)
                if (Option.isSome(profile)) {
                  voicePreferenceStore.setNativeScreenShareProfile(profile.value)
                }
              }}
            >
              <SelectTrigger
                aria-label={ts('screenShareQualityAria')}
                className="w-55 max-w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {NATIVE_SCREEN_SHARE_PROFILES.map((profile) => (
                    <SelectItem key={profile} value={profile}>
                      {t(`preferences.quality${profile}`)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          ) : (
            <Select
              items={SCREEN_SHARE_QUALITY_NAMES.map((name) => ({
                value: name,
                label: t(SCREEN_SHARE_QUALITY_LABEL_KEYS[name]),
              }))}
              value={prefs.screenShareQuality}
              onValueChange={(value) => {
                const quality = Schema.decodeUnknownOption(
                  ScreenShareQualitySchema,
                )(value)
                if (Option.isSome(quality)) {
                  voicePreferenceStore.setScreenShareQuality(quality.value)
                }
              }}
            >
              <SelectTrigger className="w-55 max-w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCREEN_SHARE_QUALITY_NAMES.map((name) => (
                  <SelectItem key={name} value={name}>
                    {t(SCREEN_SHARE_QUALITY_LABEL_KEYS[name])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </SettingsRow>

        {capabilities.nativeScreenShare ? (
          <SettingsRow label={ts('screenCapture')}>
            <Select
              items={SCREEN_SHARE_CAPTURE_MODES.map((name) => ({
                value: name,
                label: t(SCREEN_SHARE_CAPTURE_MODE_LABEL_KEYS[name]),
              }))}
              value={prefs.screenShareCaptureMode}
              onValueChange={(value) => {
                const captureMode = Schema.decodeUnknownOption(
                  ScreenShareCaptureModeSchema,
                )(value)
                if (Option.isSome(captureMode)) {
                  voicePreferenceStore.setScreenShareCaptureMode(
                    captureMode.value,
                  )
                }
              }}
            >
              <SelectTrigger className="w-55 max-w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCREEN_SHARE_CAPTURE_MODES.map((name) => (
                  <SelectItem key={name} value={name}>
                    {t(SCREEN_SHARE_CAPTURE_MODE_LABEL_KEYS[name])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
        ) : null}

        <SettingsToggleRow
          label={ts('av1')}
          hint={!av1Supported ? ts('av1Unsupported') : undefined}
          checked={prefs.screenShareCodec === 'av1'}
          disabled={!av1Supported}
          onCheckedChange={(checked) =>
            voicePreferenceStore.setScreenShareCodec(checked ? 'av1' : 'auto')
          }
        />

        <SettingsToggleRow
          label={ts('shareAudioByDefault')}
          checked={prefs.screenShareAudio}
          onCheckedChange={(checked) =>
            voicePreferenceStore.setScreenShareAudio(checked)
          }
        />
      </SettingsBlock>
    </div>
  )
}
