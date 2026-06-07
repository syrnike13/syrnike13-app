import { useEffect, useRef, useState } from 'react'

import { Button } from '#/components/ui/button'
import { Label } from '#/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
import { Slider } from '#/components/ui/slider'
import { shouldUseDesktopMediaEngine } from '#/features/voice/desktop-media-engine'
import { useVoiceAudioInputDevices } from '#/features/voice/use-voice-audio-devices'
import { useVoiceVideoDevices } from '#/features/voice/use-voice-video-devices'
import {
  ensureMediaDevicePermission,
  useMediaDevices,
} from '#/features/voice/use-media-devices'
import {
  SCREEN_SHARE_QUALITY_LABELS,
  type NoiseSuppressionMode,
  type ScreenShareQualityName,
} from '#/features/voice/voice-preference-types'
import { useVoicePreferences } from '#/features/voice/use-voice-preferences'
import {
  VOICE_OUTPUT_VOLUME_MAX,
  voicePreferenceStore,
} from '#/features/voice/voice-preference-store'
import { formatUserVolumeLabel } from '#/features/voice/voice-listener-store'
import { isAv1ScreenShareSupported } from '#/features/voice/voice-capture'
import { cn } from '#/lib/utils'

const METER_BAR_COUNT = 32

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

function useMicTestMeter(
  active: boolean,
  deviceId: string | undefined,
  inputVolume: number,
) {
  const [levels, setLevels] = useState(() =>
    Array.from({ length: METER_BAR_COUNT }, () => 0),
  )
  const streamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const gainRef = useRef<GainNode | null>(null)
  const frameRef = useRef(0)

  useEffect(() => {
    if (gainRef.current) {
      gainRef.current.gain.value = inputVolume
    }
  }, [inputVolume])

  useEffect(() => {
    if (!active) {
      setLevels(Array.from({ length: METER_BAR_COUNT }, () => 0))
      return
    }

    let cancelled = false
    const samples = new Uint8Array(512)

    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        })
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }

        const context = new AudioContext()
        const source = context.createMediaStreamSource(stream)
        const gain = context.createGain()
        const analyser = context.createAnalyser()
        analyser.fftSize = 512
        gain.gain.value = inputVolume
        source.connect(gain)
        gain.connect(analyser)

        streamRef.current = stream
        contextRef.current = context
        gainRef.current = gain

        const tick = () => {
          if (cancelled) return
          analyser.getByteTimeDomainData(samples)
          let sum = 0
          for (const sample of samples) {
            const centered = (sample - 128) / 128
            sum += centered * centered
          }
          const rms = Math.sqrt(sum / samples.length)
          const level = Math.min(1, rms * 6)

          setLevels((current) =>
            current.map((previous, index) => {
              const wave = 0.65 + ((index % 7) + 1) / 14
              const target = level * wave
              return previous * 0.45 + target * 0.55
            }),
          )
          frameRef.current = requestAnimationFrame(tick)
        }

        frameRef.current = requestAnimationFrame(tick)
      } catch {
        if (!cancelled) {
          setLevels(Array.from({ length: METER_BAR_COUNT }, () => 0))
        }
      }
    })()

    return () => {
      cancelled = true
      cancelAnimationFrame(frameRef.current)
      gainRef.current = null
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      void contextRef.current?.close()
      contextRef.current = null
    }
  }, [active, deviceId])

  return levels
}

export function SettingsVoicePanel() {
  const prefs = useVoicePreferences()
  const engineAudioInput = shouldUseDesktopMediaEngine()
  const inputDevices = useVoiceAudioInputDevices()
  const outputDevices = useMediaDevices('audiooutput')
  const videoDevices = useVoiceVideoDevices()
  const [micTestActive, setMicTestActive] = useState(false)
  const av1Supported = isAv1ScreenShareSupported()

  useEffect(() => {
    void ensureMediaDevicePermission('audio')
    void ensureMediaDevicePermission('video')
  }, [])

  useEffect(() => {
    if (!av1Supported && prefs.screenShareCodec === 'av1') {
      voicePreferenceStore.setScreenShareCodec('auto')
    }
  }, [av1Supported, prefs.screenShareCodec])

  const inputValue = prefs.preferredAudioInputDevice ?? 'default'
  const outputValue = prefs.preferredAudioOutputDevice ?? 'default'
  const videoValue = prefs.preferredVideoDevice ?? 'default'
  const micTestDeviceId =
    inputValue === 'default' ? undefined : inputValue
  const meterLevels = useMicTestMeter(
    micTestActive,
    micTestDeviceId,
    prefs.inputVolume,
  )

  return (
    <div className="space-y-8">
      <section className="space-y-4">
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

        <DeviceSelect
          label="Камера"
          devices={videoDevices}
          value={videoValue}
          onChange={(deviceId) => {
            voicePreferenceStore.setPreferredVideoDevice(
              deviceId === 'default' ? undefined : deviceId,
            )
          }}
        />

        {engineAudioInput ? (
          <p className="text-sm text-muted-foreground">
            Проверка микрофона в десктопном движке недоступна — уровень виден в
            голосовом канале при разговоре.
          </p>
        ) : (
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
        )}
      </section>

      <section className="space-y-4">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Обработка звука
        </h3>
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
              <SelectItem value="disabled">Выключено</SelectItem>
              <SelectItem value="browser">Браузер</SelectItem>
              <SelectItem value="enhanced">Усиленное (DeepFilterNet)</SelectItem>
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
          Эхоподавление браузера
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 rounded border-input accent-primary"
            checked={prefs.autoGainControl}
            onChange={(event) =>
              voicePreferenceStore.setAutoGainControl(event.target.checked)
            }
          />
          Автоматическая регулировка усиления (AGC)
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 rounded border-input accent-primary"
            checked={prefs.voiceGateEnabled}
            onChange={(event) =>
              voicePreferenceStore.setVoiceGateEnabled(event.target.checked)
            }
          />
          Гейт микрофона
        </label>
        <div className="space-y-2">
          <Label htmlFor="voice-gate-threshold">Порог гейта</Label>
          <input
            id="voice-gate-threshold"
            type="range"
            min={0}
            max={0.2}
            step={0.005}
            value={prefs.voiceGateThreshold}
            onChange={(event) => {
              voicePreferenceStore.setVoiceGateThreshold(
                Number(event.target.value),
              )
            }}
            className="w-full accent-primary"
          />
          <p className="text-sm text-muted-foreground">
            {formatUserVolumeLabel(prefs.voiceGateThreshold)}
          </p>
        </div>
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
