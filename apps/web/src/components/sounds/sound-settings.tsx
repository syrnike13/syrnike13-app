import {
  SettingsBlock,
  SettingsRow,
  SettingsToggleRow,
} from '#/components/settings/settings-panels'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
import { Slider } from '#/components/ui/slider'
import {
  authorSoundPackOptions,
  isSoundAuthorPackId,
  soundEventVolumeOptions,
} from '#/features/sounds/sound-packs'
import {
  soundPreferenceStore,
  useSoundPreferences,
} from '#/features/sounds/sound-preference-store'

function volumeToSlider(volume: number) {
  return Math.round(volume * 100)
}

function sliderToVolume(value: number) {
  return Number((value / 100).toFixed(2))
}

export function SoundSettings() {
  const preferences = useSoundPreferences()
  const authorPacks = authorSoundPackOptions()
  const soundEvents = soundEventVolumeOptions(preferences.authorPackId)

  return (
    <SettingsBlock
      title="Звуки интерфейса"
      description="Авторский пак выбирается здесь. Ивентовые паки включаются отдельно и не появляются в пользовательском выборе."
    >
      <SettingsToggleRow
        label="Проигрывать UI-звуки"
        hint="Сообщения, звонки, голосовые действия и другие короткие события приложения."
        checked={preferences.enabled}
        onCheckedChange={(enabled) => soundPreferenceStore.setEnabled(enabled)}
      />

      <SettingsRow
        label="Авторский пак"
        hint="Набор обычных звуков интерфейса. Ивентовые переопределения управляются отдельно."
      >
        <Select
          value={preferences.authorPackId}
          onValueChange={(authorPackId) => {
            if (isSoundAuthorPackId(authorPackId)) {
              soundPreferenceStore.setAuthorPackId(authorPackId)
            }
          }}
          disabled={!preferences.enabled}
        >
          <SelectTrigger className="w-[220px] max-w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {authorPacks.map((pack) => (
              <SelectItem key={pack.id} value={pack.id}>
                {pack.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>

      <SettingsRow
        label="Громкость UI-звуков"
        value={`${volumeToSlider(preferences.volume)}%`}
        stacked
      >
        <Slider
          className="w-full"
          value={[volumeToSlider(preferences.volume)]}
          min={0}
          max={100}
          step={1}
          disabled={!preferences.enabled}
          onValueChange={([next]) => {
            if (next == null) return
            soundPreferenceStore.setVolume(sliderToVolume(next))
          }}
        />
      </SettingsRow>

      {soundEvents.map((event) => {
        const eventVolume = preferences.eventVolumes[event.id] ?? 1
        return (
          <SettingsRow
            key={event.id}
            label={event.label}
            value={`${volumeToSlider(eventVolume)}%`}
            stacked
          >
            <Slider
              className="w-full"
              value={[volumeToSlider(eventVolume)]}
              min={0}
              max={100}
              step={1}
              disabled={!preferences.enabled}
              onValueChange={([next]) => {
                if (next == null) return
                soundPreferenceStore.setEventVolume(
                  event.id,
                  sliderToVolume(next),
                )
              }}
            />
          </SettingsRow>
        )
      })}

      <SettingsToggleRow
        label="Пасхальные звуки"
        hint="Редкая альтернативная вариация для тех же UI-событий. Шанс срабатывания — 0.25%."
        checked={preferences.easterEnabled}
        onCheckedChange={(easterEnabled) =>
          soundPreferenceStore.setEasterEnabled(easterEnabled)
        }
        disabled={!preferences.enabled}
      />
    </SettingsBlock>
  )
}
