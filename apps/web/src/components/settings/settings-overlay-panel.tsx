import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  DEFAULT_DESKTOP_OVERLAY_SETTINGS,
  type DesktopOverlaySettings,
  type DesktopOverlayState,
} from '@syrnike13/platform'

import {
  SettingsBlock,
  SettingsRow,
} from '#/components/settings/settings-panels'
import { Switch } from '#/components/ui/switch'
import { usePlatform } from '#/platform/use-platform'

export function overlayStateNeedsSettingsReload(
  previous: DesktopOverlayState | null,
  next: DesktopOverlayState,
) {
  if (!previous) return Boolean(next.target)
  if (previous.available !== next.available) return true
  if (!next.target) return false
  if (!previous.target) return true
  return (
    previous.target.gameId !== next.target.gameId ||
    previous.target.processName !== next.target.processName ||
    previous.target.processPath !== next.target.processPath ||
    previous.target.title !== next.target.title
  )
}

export function SettingsOverlayPanel() {
  const { desktop, os } = usePlatform()
  const [settings, setSettings] = useState<DesktopOverlaySettings | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!desktop || os !== 'win32') return
    let cancelled = false
    let previousOverlayState: DesktopOverlayState | null = null

    const loadSettings = () => {
      void desktop.settings
        .load()
        .then((value) => {
          if (!cancelled) setSettings(value.overlay)
        })
        .catch((error) => {
          console.error('[settings-overlay] failed to load settings', error)
          if (cancelled) return
          setSettings({ ...DEFAULT_DESKTOP_OVERLAY_SETTINGS })
          toast.error(
            error instanceof Error
              ? error.message
              : 'Не удалось загрузить настройки оверлея',
          )
        })
    }

    loadSettings()
    const unsubscribe = desktop.overlay.onStateChange((nextOverlayState) => {
      setSettings((current) =>
        current && current.enabled !== nextOverlayState.enabled
          ? { ...current, enabled: nextOverlayState.enabled }
          : current,
      )
      if (
        overlayStateNeedsSettingsReload(
          previousOverlayState,
          nextOverlayState,
        )
      ) {
        loadSettings()
      }
      previousOverlayState = nextOverlayState
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [desktop, os])

  const games = useMemo(
    () =>
      [...(settings?.games ?? [])].sort(
        (left, right) => right.lastSeenAt - left.lastSeenAt,
      ),
    [settings?.games],
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

  function save(nextSettings: DesktopOverlaySettings) {
    if (!desktop || saving) return
    const previous = settings
    setSettings(nextSettings)
    setSaving(true)
    void desktop.settings
      .update({ overlay: nextSettings })
      .then((value) => setSettings(value.overlay))
      .catch((error) => {
        setSettings(previous)
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
            checked={settings?.enabled ?? true}
            disabled={!settings || saving}
            onCheckedChange={(enabled) => {
              if (!settings) return
              save({ ...settings, enabled })
            }}
          />
        </SettingsRow>
      </SettingsBlock>

      <SettingsBlock
        title="Игры"
        description="Игра появится здесь после того, как станет активным окном и пройдет детект по runtime-сигналам."
      >
        {!settings ? (
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
                    if (!settings) return
                    save({
                      ...settings,
                      games: settings.games.map((item) =>
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
