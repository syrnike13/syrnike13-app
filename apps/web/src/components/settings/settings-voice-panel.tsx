import { useEffect, useSyncExternalStore } from 'react'

import { Label } from '#/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
import {
  ensureMediaDevicePermission,
  useMediaDevices,
} from '#/features/voice/use-media-devices'
import {
  SCREEN_SHARE_QUALITY_LABELS,
  type NoiseSuppressionMode,
  type ScreenShareQualityName,
} from '#/features/voice/voice-preference-types'
import {
  VOICE_OUTPUT_VOLUME_MAX,
  voicePreferenceStore,
} from '#/features/voice/voice-preference-store'
import { formatUserVolumeLabel } from '#/features/voice/voice-listener-store'

function DeviceSelect({
  label,
  hint,
  value,
  devices,
  onChange,
}: {
  label: string
  hint?: string
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
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
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

function useVoicePreferences() {
  return useSyncExternalStore(
    voicePreferenceStore.subscribe,
    () => voicePreferenceStore.getState(),
    () => voicePreferenceStore.getState(),
  )
}

export function SettingsVoicePanel() {
  const prefs = useVoicePreferences()
  const inputDevices = useMediaDevices('audioinput')
  const outputDevices = useMediaDevices('audiooutput')
  const videoDevices = useMediaDevices('videoinput')

  useEffect(() => {
    void ensureMediaDevicePermission('audio')
    void ensureMediaDevicePermission('video')
  }, [])

  const inputValue = prefs.preferredAudioInputDevice ?? 'default'
  const outputValue = prefs.preferredAudioOutputDevice ?? 'default'
  const videoValue = prefs.preferredVideoDevice ?? 'default'

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div>
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Устройства
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Применяются при следующем подключении к голосу или сразу, если вы
            уже в канале.
          </p>
        </div>
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
      </section>

      <section className="space-y-4">
        <div>
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Обработка звука
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Эхоподавление и шумоподавление микрофона. Для смены режима RNNoise
            переподключитесь к голосу.
          </p>
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
              <SelectItem value="disabled">Выключено</SelectItem>
              <SelectItem value="browser">Браузер</SelectItem>
              <SelectItem value="enhanced">Усиленное (RNNoise)</SelectItem>
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
        <div>
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Демонстрация экрана
          </h3>
        </div>
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
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 rounded border-input accent-primary"
            checked={prefs.screenShareQualityAsk}
            onChange={(event) =>
              voicePreferenceStore.setScreenShareQualityAsk(event.target.checked)
            }
          />
          Спрашивать качество перед каждой демонстрацией
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
        <div>
          <Label htmlFor="voice-output-volume">Громкость входящего голоса</Label>
          <p className="mt-1 text-xs text-muted-foreground">
            Общий множитель для всех участников (не глушит отдельных
            пользователей в меню профиля).
          </p>
        </div>
        <input
          id="voice-output-volume"
          type="range"
          min={0}
          max={VOICE_OUTPUT_VOLUME_MAX}
          step={0.05}
          value={prefs.outputVolume}
          onChange={(event) => {
            voicePreferenceStore.setOutputVolume(Number(event.target.value))
          }}
          className="w-full accent-primary"
        />
        <p className="text-sm text-muted-foreground">
          {formatUserVolumeLabel(prefs.outputVolume)}
        </p>
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
