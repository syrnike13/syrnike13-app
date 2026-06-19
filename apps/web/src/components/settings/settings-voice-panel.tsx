import { useEffect, useRef, useState } from 'react'

import {
  SettingsBlock,
  SettingsRow,
  SettingsToggleRow,
} from '#/components/settings/settings-panels'
import { VoiceGateSensitivityBar } from '#/components/settings/voice-gate-sensitivity-bar'
import { Button } from '#/components/ui/button'
import { Switch } from '#/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
import { Slider } from '#/components/ui/slider'
import {
  ensureMediaDevicePermission,
  useMediaDevices,
} from '#/features/voice/use-media-devices'
import {
  SCREEN_SHARE_CAPTURE_MODE_LABELS,
  SCREEN_SHARE_QUALITY_LABELS,
  type ScreenShareCaptureMode,
  type ScreenShareQualityName,
  type VoiceInputMode,
} from '#/features/voice/voice-preference-types'
import { usePlatform } from '#/platform/use-platform'
import { useVoicePreferences } from '#/features/voice/use-voice-preferences'
import {
  VOICE_OUTPUT_VOLUME_MAX,
  voicePreferenceStore,
} from '#/features/voice/voice-preference-store'
import { isAv1ScreenShareSupported } from '#/features/voice/voice-capture'
import { useMicPreviewLoopback } from '#/features/voice/use-mic-preview-loopback'
import { useVoice } from '#/features/voice/voice-context'
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
  const selectableDevices = devices.filter((device) => device.deviceId.length > 0)
  const selectValue =
    value.length > 0 &&
    (value === 'default' ||
      selectableDevices.some((device) => device.deviceId === value))
      ? value
      : 'default'

  return (
    <div className="space-y-2">
      <p className="text-base font-medium">{label}</p>
      <Select value={selectValue} onValueChange={onChange}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="По умолчанию" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="default">По умолчанию</SelectItem>
          {selectableDevices.map((device) => (
            <SelectItem key={device.deviceId} value={device.deviceId}>
              {device.label || 'Устройство'}
            </SelectItem>
          ))}
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
        onValueChange={([next]) => {
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
  const prefs = useVoicePreferences()
  const { capabilities } = usePlatform()
  const { setInputMode, setSelfMonitoringActive } = useVoice()
  const setSelfMonitoringActiveRef = useRef(setSelfMonitoringActive)
  const inputDevices = useMediaDevices('audioinput')
  const outputDevices = useMediaDevices('audiooutput')
  const [micTestActive, setMicTestActive] = useState(false)
  const av1Supported = isAv1ScreenShareSupported()

  useEffect(() => {
    void ensureMediaDevicePermission('audio')
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
      <SettingsBlock title="Устройства">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div className="space-y-4">
            <DeviceSelectField
              label="Микрофон"
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
              label="Громкость микрофона"
              value={prefs.inputVolume}
              onChange={(value) => {
                voicePreferenceStore.setInputVolume(value)
              }}
            />
          </div>

          <div className="space-y-4">
            <DeviceSelectField
              label="Динамики / наушники"
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
              label="Громкость"
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
                {micTestActive ? 'Остановить' : 'Проверка микрофона'}
              </Button>
              <MicInputMeter levels={meterLevels} />
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              {micTestActive
                ? 'Слышите обработанный сигнал с выбранного микрофона — как в голосовом канале. Лучше в наушниках.'
                : 'Воспроизведёт обработанный сигнал через выбранный вывод.'}
            </p>
          </div>
        </div>
      </SettingsBlock>

      <SettingsBlock title="Обработка звука">
        <SettingsRow
          label="Режим ввода"
          hint="Voice Activity передаёт голос по порогу чувствительности, Push-to-Talk открывает микрофон только пока удерживается горячая клавиша."
        >
          <Select
            value={prefs.inputMode}
            onValueChange={(value) => setInputMode(value as VoiceInputMode)}
          >
            <SelectTrigger className="w-[220px] max-w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="voice-activity">Voice Activity</SelectItem>
              <SelectItem value="push-to-talk">Push-to-Talk</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>

        <SettingsRow
          label="Автоматическая чувствительность"
          hint="Регулируйте порог передачи звука в Сырниках"
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
          label="Шумоподавление"
          checked={prefs.noiseSuppression}
          onCheckedChange={(checked) =>
            voicePreferenceStore.setNoiseSuppression(checked)
          }
        />

        <SettingsToggleRow
          label="Эхоподавление"
          checked={prefs.echoCancellation}
          onCheckedChange={(checked) =>
            voicePreferenceStore.setEchoCancellation(checked)
          }
        />
      </SettingsBlock>

      <SettingsBlock title="Демонстрация экрана">
        <SettingsRow label="Качество по умолчанию">
          <Select
            value={prefs.screenShareQuality}
            onValueChange={(value) =>
              voicePreferenceStore.setScreenShareQuality(
                value as ScreenShareQualityName,
              )
            }
          >
            <SelectTrigger className="w-[220px] max-w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SCREEN_SHARE_QUALITY_LABELS) as ScreenShareQualityName[]).map(
                (name) => (
                  <SelectItem key={name} value={name}>
                    {SCREEN_SHARE_QUALITY_LABELS[name]}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
        </SettingsRow>

        {capabilities.nativeScreenShare ? (
          <SettingsRow label="Захват экрана">
            <Select
              value={prefs.screenShareCaptureMode}
              onValueChange={(value) =>
                voicePreferenceStore.setScreenShareCaptureMode(
                  value as ScreenShareCaptureMode,
                )
              }
            >
              <SelectTrigger className="w-[220px] max-w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(
                  Object.keys(
                    SCREEN_SHARE_CAPTURE_MODE_LABELS,
                  ) as ScreenShareCaptureMode[]
                ).map((name) => (
                  <SelectItem key={name} value={name}>
                    {SCREEN_SHARE_CAPTURE_MODE_LABELS[name]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
        ) : null}

        <SettingsToggleRow
          label="AV1 (экспериментально)"
          hint={!av1Supported ? 'Не поддерживается в этом браузере' : undefined}
          checked={prefs.screenShareCodec === 'av1'}
          disabled={!av1Supported}
          onCheckedChange={(checked) =>
            voicePreferenceStore.setScreenShareCodec(checked ? 'av1' : 'auto')
          }
        />

        <SettingsToggleRow
          label="Передавать звук с экрана по умолчанию"
          checked={prefs.screenShareAudio}
          onCheckedChange={(checked) =>
            voicePreferenceStore.setScreenShareAudio(checked)
          }
        />
      </SettingsBlock>
    </div>
  )
}
