import { useEffect, useRef, useState } from 'react'

import { VoiceGateSensitivityBar } from '#/components/settings/voice-gate-sensitivity-bar'
import { Button } from '#/components/ui/button'
import { Label } from '#/components/ui/label'
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
  type NoiseSuppressionMode,
  type ScreenShareCaptureMode,
  type ScreenShareQualityName,
} from '#/features/voice/voice-preference-types'
import { usePlatform } from '#/platform/use-platform'
import { useVoicePreferences } from '#/features/voice/use-voice-preferences'
import {
  VOICE_OUTPUT_VOLUME_MAX,
  voicePreferenceStore,
} from '#/features/voice/voice-preference-store'
import { formatUserVolumeLabel } from '#/features/voice/voice-listener-store'
import { isAv1ScreenShareSupported } from '#/features/voice/voice-capture'
import { useMicPreviewLoopback } from '#/features/voice/use-mic-preview-loopback'
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

function DeviceSelect({
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
      <Label>{label}</Label>
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

function VolumeSlider({
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
      <Label htmlFor={id}>{label}</Label>
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
  useVoiceGateMeter(!micTestActive, micTestDeviceId, gateMetricsRef)

  return (
    <div className="space-y-8">
      <section className="space-y-4 border-b border-border/60 pb-8">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Устройства
        </h3>

        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-4">
            <DeviceSelect
              label="Микрофон"
              devices={inputDevices}
              value={inputValue}
              onChange={(deviceId) => {
                voicePreferenceStore.setPreferredAudioInputDevice(
                  deviceId === 'default' ? undefined : deviceId,
                )
              }}
            />
            <VolumeSlider
              id="voice-input-volume"
              label="Громкость микрофона"
              value={prefs.inputVolume}
              onChange={(value) => {
                voicePreferenceStore.setInputVolume(value)
              }}
            />
          </div>

          <div className="space-y-4">
            <DeviceSelect
              label="Динамики / наушники"
              devices={outputDevices}
              value={outputValue}
              onChange={(deviceId) => {
                voicePreferenceStore.setPreferredAudioOutputDevice(
                  deviceId === 'default' ? undefined : deviceId,
                )
              }}
            />
            <VolumeSlider
              id="voice-output-volume"
              label="Громкость"
              value={prefs.outputVolume}
              onChange={(value) => {
                voicePreferenceStore.setOutputVolume(value)
              }}
            />
          </div>
        </div>

        <div className="space-y-2">
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
          <p className="text-sm text-muted-foreground">
            {micTestActive
              ? 'Слышите обработанный сигнал с выбранного микрофона — как в голосовом канале. Лучше в наушниках.'
              : 'Воспроизведёт обработанный сигнал через выбранный вывод.'}
          </p>
        </div>
      </section>

      <section className="space-y-4 border-b border-border/60 pb-8">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Обработка звука
        </h3>

        <div className="space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">
                Автоматическая чувствительность
              </p>
              <p className="text-xs text-muted-foreground">
                Регулирует, сколько звука передаётся с микрофона. Порог
                подстраивается по тишине, а не по голосу.
              </p>
            </div>
            <Switch
              checked={prefs.voiceGateAutoThreshold}
              onCheckedChange={(checked) =>
                voicePreferenceStore.setVoiceGateAutoThreshold(checked)
              }
            />
          </div>

          <VoiceGateSensitivityBar
            metricsRef={gateMetricsRef}
            thresholdDb={prefs.voiceGateThresholdDb}
            auto={prefs.voiceGateAutoThreshold}
            onThresholdChange={(thresholdDb) =>
              voicePreferenceStore.setVoiceGateThresholdDb(thresholdDb)
            }
          />
        </div>

        <div className="space-y-2">
          <Label>Шумоподавление</Label>
          <Select
            value={prefs.noiseSuppression}
            onValueChange={(value) =>
              voicePreferenceStore.setNoiseSuppression(
                value as NoiseSuppressionMode,
              )
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="enhanced">Включено (DeepFilterNet3)</SelectItem>
              <SelectItem value="disabled">Выключено</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 rounded border-input accent-primary"
            checked={prefs.echoCancellation}
            onChange={(event) =>
              voicePreferenceStore.setEchoCancellation(event.target.checked)
            }
          />
          Эхоподавление
        </label>
      </section>

      <section className="space-y-4">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Демонстрация экрана
        </h3>
        <div className="space-y-2">
          <Label>Качество по умолчанию</Label>
          <Select
            value={prefs.screenShareQuality}
            onValueChange={(value) =>
              voicePreferenceStore.setScreenShareQuality(
                value as ScreenShareQualityName,
              )
            }
          >
            <SelectTrigger className="w-full">
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
        </div>
        {capabilities.nativeScreenShare ? (
          <div className="space-y-2">
            <Label>Захват экрана</Label>
            <Select
              value={prefs.screenShareCaptureMode}
              onValueChange={(value) =>
                voicePreferenceStore.setScreenShareCaptureMode(
                  value as ScreenShareCaptureMode,
                )
              }
            >
              <SelectTrigger className="w-full">
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
          </div>
        ) : null}
        <label
          className={cn(
            'flex items-center gap-2 text-sm',
            av1Supported ? 'cursor-pointer' : 'cursor-not-allowed opacity-50',
          )}
        >
          <input
            type="checkbox"
            className="size-4 rounded border-input accent-primary"
            disabled={!av1Supported}
            checked={prefs.screenShareCodec === 'av1'}
            onChange={(event) =>
              voicePreferenceStore.setScreenShareCodec(
                event.target.checked ? 'av1' : 'auto',
              )
            }
          />
          AV1 (экспериментально)
          {!av1Supported ? (
            <span className="text-muted-foreground">— не поддерживается</span>
          ) : null}
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 rounded border-input accent-primary"
            checked={prefs.screenShareAudio}
            onChange={(event) =>
              voicePreferenceStore.setScreenShareAudio(event.target.checked)
            }
          />
          Передавать звук с экрана по умолчанию
        </label>
        {!capabilities.nativeScreenShare ? (
          <p className="text-xs text-muted-foreground">
            В браузере звук экрана может дублировать голоса участников. В
            desktop-приложении Windows захват исключает звук Syrnike и
            передаётся в стерео.
          </p>
        ) : null}
      </section>

      <section className="space-y-3">
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 rounded border-input accent-primary"
            checked={prefs.autoBalanceEnabled}
            onChange={(event) =>
              voicePreferenceStore.setAutoBalanceEnabled(event.target.checked)
            }
          />
          Авто-баланс участников
        </label>
        <div className="space-y-2">
          <Label htmlFor="voice-auto-balance-strength">Сила авто-баланса</Label>
          <input
            id="voice-auto-balance-strength"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={prefs.autoBalanceStrength}
            onChange={(event) => {
              voicePreferenceStore.setAutoBalanceStrength(
                Number(event.target.value),
              )
            }}
            className="w-full accent-primary"
          />
          <p className="text-sm text-muted-foreground">
            {formatUserVolumeLabel(prefs.autoBalanceStrength)}
          </p>
        </div>
      </section>
    </div>
  )
}
