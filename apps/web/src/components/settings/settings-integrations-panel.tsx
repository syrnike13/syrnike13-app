import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type {
  DesktopLocalSettingsPatch,
  DesktopMusicSettings,
  DesktopMusicSettingsPatch,
  MusicProviderId,
} from '@syrnike13/platform'

import { SettingsBlock, SettingsRow } from '#/components/settings/settings-panels'
import { Switch } from '#/components/ui/switch'
import {
  loadDesktopLocalSettings,
  updateDesktopLocalSettings,
} from '#/features/settings/desktop-local-settings-client'

const providerRows: Array<{
  id: MusicProviderId
  label: string
}> = [
  { id: 'spotify', label: 'Spotify' },
  { id: 'apple_music', label: 'Apple Music' },
  { id: 'yandex_music', label: 'Яндекс Музыка' },
]

function mergeMusicSettings(
  current: DesktopMusicSettings,
  patch: DesktopMusicSettingsPatch,
): DesktopMusicSettings {
  return {
    ...current,
    ...patch,
    providers: {
      ...current.providers,
      ...patch.providers,
      spotify: {
        ...current.providers.spotify,
        ...patch.providers?.spotify,
      },
      apple_music: {
        ...current.providers.apple_music,
        ...patch.providers?.apple_music,
      },
      yandex_music: {
        ...current.providers.yandex_music,
        ...patch.providers?.yandex_music,
      },
    },
  }
}

export function SettingsIntegrationsPanel() {
  const [music, setMusic] = useState<DesktopMusicSettings | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [savingKey, setSavingKey] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadDesktopLocalSettings()
      .then((settings) => {
        if (cancelled) return
        setMusic(settings?.music ?? null)
      })
      .catch((error) => {
        if (cancelled) return
        setMusic(null)
        toast.error(
          error instanceof Error
            ? error.message
            : 'Не удалось загрузить настройки интеграций',
        )
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function saveMusicPatch(
    key: string,
    patch: NonNullable<DesktopLocalSettingsPatch['music']>,
  ) {
    if (!music || savingKey) return

    const previous = music
    setSavingKey(key)
    setMusic(mergeMusicSettings(music, patch))
    try {
      const next = await updateDesktopLocalSettings({ music: patch })
      setMusic(next?.music ?? previous)
    } catch (error) {
      setMusic(previous)
      toast.error(
        error instanceof Error
          ? error.message
          : 'Не удалось сохранить настройки интеграций',
      )
    } finally {
      setSavingKey(null)
    }
  }

  if (!loaded) {
    return (
      <SettingsBlock title="Музыка">
        <SettingsRow label="Статус" value="Загрузка…" />
      </SettingsBlock>
    )
  }

  if (!music) {
    return (
      <SettingsBlock title="Музыка">
        <SettingsRow
          label="Desktop-приложение"
          value="Интеграции доступны в desktop-клиенте"
        />
      </SettingsBlock>
    )
  }

  return (
    <div className="space-y-2">
      <SettingsBlock title="Музыка">
        <SettingsRow label="Включить музыкальный статус">
          <Switch
            aria-label="Включить музыкальный статус"
            checked={music.enabled}
            disabled={savingKey !== null}
            onCheckedChange={(checked) =>
              void saveMusicPatch('enabled', { enabled: checked })
            }
          />
        </SettingsRow>
        <SettingsRow label="Показывать в профиле">
          <Switch
            aria-label="Показывать в профиле"
            checked={music.showInProfile}
            disabled={!music.enabled || savingKey !== null}
            onCheckedChange={(checked) =>
              void saveMusicPatch('showInProfile', { showInProfile: checked })
            }
          />
        </SettingsRow>
      </SettingsBlock>

      <SettingsBlock title="Площадки">
        {providerRows.map((provider) => (
          <SettingsRow key={provider.id} label={provider.label}>
            <Switch
              aria-label={provider.label}
              checked={music.providers[provider.id].enabled}
              disabled={!music.enabled || savingKey !== null}
              onCheckedChange={(checked) =>
                void saveMusicPatch(`provider:${provider.id}`, {
                  providers: {
                    [provider.id]: {
                      enabled: checked,
                    },
                  },
                })
              }
            />
          </SettingsRow>
        ))}
      </SettingsBlock>
    </div>
  )
}
