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
import { Slider } from '@syrnike13/ui/primitives/slider'
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
  NATIVE_SCREEN_SHARE_PROFILE_LABELS,
} from '#/features/voice/voice-preference-types'
import { usePlatform } from '#/platform/use-platform'
import { useVoicePreferences } from '#/features/voice/use-voice-preferences'
import {
  VOICE_OUTPUT_VOLUME_MAX,
  voicePreferenceStore,
} from '#/features/voice/voice-preference-store'
import { isAv1ScreenShareSupported } from '#/features/voice/voice-capture'
import { useMicPreviewLoopback } from '#/features/voice/use-mic-preview-loopback'
import { useVoiceMedia } from '#/features/voice/voice-media-context'
import { useVoiceGateMeter } from '#/features/voice/use-voice-gate-meter'
import type { VoiceGateMetrics } from '#/features/voice/voice-gate-stage'
import {
  DEFAULT_VOICE_GATE_THRESHOLD_DB,
  VOICE_GATE_DB_MIN,
} from '#/features/voice/voice-gate-level'
import { cn } from '#/lib/utils'

function volumeToSlider(volume: number) {
  return Math.round((volume / VOICE_OUTPUT_VOLUME_MAX) * 100)
}

function sliderToVolume(value: number) {
  return Number(((value / 100) * VOICE_OUTPUT_VOLUME_MAX).toFixed(2))
}

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

  return (
    <div className="space-y-2">
      <p className="text-base font-medium">{label}</p>
      <Select
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
    </div>
  )
}

function VolumeSliderField({
  id,
  label,
  value,
  onChange,
}: {
  id: string
  label: string
  value: number
  onChange: (value: number) => void
}) {
  return (
    <div className="space-y-2">
      <p className="text-base font-medium">{label}</p>
      <Slider
        id={id}
        value={[volumeToSlider(value)]}
        min={0}
        max={100}
        step={1}
        onValueChange={(value) => {
          const next = typeof value === 'number' ? value : value[0]
          if (next == null) return
          onChange(sliderToVolume(next))
        }}
      />
    </div>
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
            'min-h-1 flex-1 rounded-sm bg-muted transition-[height,background-color] duration-75',
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

export function SettingsVoicePanel() {
  const t = useTranslations('voice')
  const ts = useTranslations('settings.voice')
  const prefs = useVoicePreferences()
  const { capabilities, os } = usePlatform()
  const { setSelfMonitoringActive } = useVoiceMedia()
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
                className="w-[13.75rem] max-w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="hd720p30">720p · 30 FPS</SelectItem>
                  <SelectItem value="hd1080p30">1080p · 30 FPS</SelectItem>
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
              id="voice-input-volume"
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
              id="voice-output-volume"
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
                className="w-[13.75rem] max-w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {NATIVE_SCREEN_SHARE_PROFILES.map((profile) => (
                    <SelectItem key={profile} value={profile}>
                      {NATIVE_SCREEN_SHARE_PROFILE_LABELS[profile]}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          ) : (
            <Select
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
              <SelectTrigger className="w-[13.75rem] max-w-full">
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
              <SelectTrigger className="w-[13.75rem] max-w-full">
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
