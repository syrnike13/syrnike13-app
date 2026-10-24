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

      <SettingsRow label={t('volume')}>
        <VolumeControl
          label={t('volume')}
          value={preferences.volume}
          disabled={!preferences.enabled}
          onChange={(volume) => soundPreferenceStore.setVolume(volume)}
        />
      </SettingsRow>

      {soundEvents.map((event) => (
        <SettingsRow key={event.id} label={t(event.labelKey)}>
          <VolumeControl
            label={t(event.labelKey)}
            value={preferences.eventVolumes[event.id] ?? 1}
            disabled={!preferences.enabled}
            onChange={(volume) =>
              soundPreferenceStore.setEventVolume(event.id, volume)
            }
          />
        </SettingsRow>
      ))}
    </SettingsBlock>
  )
}

/** Compact volume: a 192px slider and its percentage, beside the row label. */
function VolumeControl({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string
  value: number
  disabled: boolean
  onChange: (volume: number) => void
}) {
  return (
    <div className="flex w-56 shrink-0 items-center gap-3">
      <PresetSlider
        stops={VOLUME_STOPS}
        value={volumeToSlider(value)}
        mode="continuous"
        step={1}
        showLabels={false}
        showMarks={false}
        disabled={disabled}
        onValueChange={(next) => onChange(sliderToVolume(next))}
        formatValue={formatVolume}
        aria-label={label}
      />
      <span className="w-10 shrink-0 text-right text-sm text-muted-foreground tabular-nums">
        {formatVolume(volumeToSlider(value))}
      </span>
    </div>
  )
}
