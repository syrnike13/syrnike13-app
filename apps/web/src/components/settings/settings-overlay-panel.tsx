import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { DesktopOverlayPreferences } from '@syrnike13/platform'

import {
  SettingsBlock,
  SettingsRow,
} from '#/components/settings/settings-panels'
import { Switch } from '#/components/ui/switch'
import { usePlatform } from '#/platform/use-platform'

export function SettingsOverlayPanel() {
  const { desktop, os } = usePlatform()
  const [preferences, setPreferences] =
    useState<DesktopOverlayPreferences | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!desktop || os !== 'win32') return
    let cancelled = false

    const loadPreferences = () => {
      void desktop.overlay.getPreferences().then((value) => {
        if (!cancelled) setPreferences(value)
      })
    }

    loadPreferences()
    const unsubscribe = desktop.overlay.onStateChange(loadPreferences)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [desktop, os])

  const games = useMemo(
    () =>
      [...(preferences?.games ?? [])].sort(
        (left, right) => right.lastSeenAt - left.lastSeenAt,
      ),
    [preferences?.games],
  )

  if (!desktop || os !== 'win32') {
    return (
      <SettingsBlock title="Оверлей">
        <SettingsRow
          label="Недоступно"
          value="Оверлей работает только в Windows-приложении."
        />
      </SettingsBlock>
    )
  }

  function save(nextPreferences: DesktopOverlayPreferences) {
    if (!desktop || saving) return
    const previous = preferences
    setPreferences(nextPreferences)
    setSaving(true)
    void desktop.overlay
      .setPreferences(nextPreferences)
      .then(setPreferences)
      .catch((error) => {
        setPreferences(previous)
        toast.error(
          error instanceof Error
            ? error.message
            : 'Не удалось сохранить настройки оверлея',
        )
      })
      .finally(() => setSaving(false))
  }

  return (
    <div className="space-y-2">
      <SettingsBlock title="Оверлей">
        <SettingsRow
          label="Включить оверлей"
          hint="Оверлей показывается только поверх активных окон, которые детектор распознал как игры."
        >
          <Switch
            checked={preferences?.enabled ?? true}
            disabled={!preferences || saving}
            onCheckedChange={(enabled) => {
              if (!preferences) return
              save({ ...preferences, enabled })
            }}
          />
        </SettingsRow>
      </SettingsBlock>

      <SettingsBlock
        title="Игры"
        description="Игра появится здесь после того, как станет активным окном и пройдет детект по runtime-сигналам."
      >
        {!preferences ? (
          <p className="text-sm text-muted-foreground">Загрузка…</p>
        ) : games.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            Детектнутых игр пока нет.
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {games.map((game) => (
              <SettingsRow
                key={game.id}
                label={game.title || game.processName}
                value={game.processPath ?? game.processName}
              >
                <Switch
                  checked={game.enabled}
                  disabled={saving}
                  onCheckedChange={(enabled) => {
                    if (!preferences) return
                    save({
                      ...preferences,
                      games: preferences.games.map((item) =>
                        item.id === game.id ? { ...item, enabled } : item,
                      ),
                    })
                  }}
                />
              </SettingsRow>
            ))}
          </div>
        )}
      </SettingsBlock>
    </div>
  )
}
