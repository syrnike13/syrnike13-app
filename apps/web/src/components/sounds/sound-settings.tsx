import { useTranslations } from '@syrnike13/ui/i18n'

import {
  SettingsBlock,
  SettingsRow,
} from '#/components/settings/settings-panels'
import { PresetSlider } from '#/components/ui/preset-slider'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@syrnike13/ui/primitives/select'
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

const VOLUME_STOPS = [{ value: 0 }, { value: 100 }] as const

function formatVolume(value: number) {
  return `${value}%`
}

export function SoundSettings() {
  const t = useTranslations('sounds')
  const preferences = useSoundPreferences()
  const authorPacks = authorSoundPackOptions()
  const soundEvents = soundEventVolumeOptions(preferences.authorPackId)

  return (
    <SettingsBlock title={t('title')}>
      <SettingsRow label={t('packLabel')}>
        <Select
          items={authorPacks.map((pack) => ({
            value: pack.id,
            label: t(pack.labelKey),
          }))}
          value={preferences.authorPackId}
          onValueChange={(authorPackId) => {
            if (isSoundAuthorPackId(authorPackId)) {
              soundPreferenceStore.setAuthorPackId(authorPackId)
            }
          }}
          disabled={!preferences.enabled}
        >
          <SelectTrigger className="w-55 max-w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {authorPacks.map((pack) => (
              <SelectItem key={pack.id} value={pack.id}>
                {t(pack.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>

      <SettingsRow
        label={t('volume')}
        value={`${volumeToSlider(preferences.volume)}%`}
        stacked
      >
        <PresetSlider
          stops={VOLUME_STOPS}
          value={volumeToSlider(preferences.volume)}
          mode="continuous"
          step={1}
          showLabels={false}
          showMarks={false}
          disabled={!preferences.enabled}
          onValueChange={(next) =>
            soundPreferenceStore.setVolume(sliderToVolume(next))
          }
          formatValue={formatVolume}
          aria-label={t('volume')}
        />
      </SettingsRow>

      {soundEvents.map((event) => {
        const eventVolume = preferences.eventVolumes[event.id] ?? 1
        return (
          <SettingsRow
            key={event.id}
            label={t(event.labelKey)}
            value={`${volumeToSlider(eventVolume)}%`}
            stacked
          >
            <PresetSlider
              stops={VOLUME_STOPS}
              value={volumeToSlider(eventVolume)}
              mode="continuous"
              step={1}
              showLabels={false}
              showMarks={false}
              disabled={!preferences.enabled}
              onValueChange={(next) =>
                soundPreferenceStore.setEventVolume(
                  event.id,
                  sliderToVolume(next),
                )
              }
              formatValue={formatVolume}
              aria-label={t(event.labelKey)}
            />
          </SettingsRow>
        )
      })}

    </SettingsBlock>
  )
}
