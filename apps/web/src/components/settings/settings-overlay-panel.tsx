import { useEffect, useMemo, useState } from 'react'
import { Effect, Fiber } from 'effect'
import { useTranslations } from '@syrnike13/ui/i18n'
import {
  DEFAULT_DESKTOP_OVERLAY_SETTINGS,
  type DesktopOverlaySettings,
  type DesktopOverlayState,
} from '@syrnike13/platform'

import {
  SettingsBlock,
  SettingsRow,
} from '#/components/settings/settings-panels'
import { Empty, EmptyDescription } from '@syrnike13/ui/primitives/empty'
import { Switch } from '@syrnike13/ui/primitives/switch'
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
  const t = useTranslations('settings.overlay')
  const { desktop, os } = usePlatform()
  const [settings, setSettings] = useState<DesktopOverlaySettings | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!desktop || os !== 'win32') return
    let previousOverlayState: DesktopOverlayState | null = null
    let loadFiber: ReturnType<typeof Effect.runFork> | undefined

    const loadSettings = () => {
      if (loadFiber) Effect.runFork(Fiber.interrupt(loadFiber))
      loadFiber = Effect.runFork(
        Effect.tryPromise({
          try: () => desktop.settings.load(),
          catch: (cause) => cause,
        }).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.sync(() => {
                console.error(
                  '[settings-overlay] failed to load settings',
                  error,
                )
                setSettings({ ...DEFAULT_DESKTOP_OVERLAY_SETTINGS })
              }),
            onSuccess: (value) =>
              Effect.sync(() => {
                setSettings(value.overlay)
              }),
          }),
        ),
      )
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
      unsubscribe()
      if (loadFiber) Effect.runFork(Fiber.interrupt(loadFiber))
    }
  }, [desktop, os, t])

  const games = useMemo(
    () =>
      [...(settings?.games ?? [])].sort(
        (left, right) => right.lastSeenAt - left.lastSeenAt,
      ),
    [settings?.games],
  )

  if (!desktop || os !== 'win32') {
    return (
      <SettingsBlock title={t('title')}>
        <SettingsRow
          label={t('unavailable')}
          value={t('unavailableHint')}
        />
      </SettingsBlock>
    )
  }

  function save(nextSettings: DesktopOverlaySettings) {
    if (!desktop || saving) return
    const previous = settings
    setSettings(nextSettings)
    setSaving(true)
    Effect.runFork(
      Effect.tryPromise({
        try: () => desktop.settings.update({ overlay: nextSettings }),
        catch: (cause) => cause,
      }).pipe(
        Effect.matchEffect({
          onFailure: () =>
            Effect.sync(() => {
              setSettings(previous)
            }),
          onSuccess: (value) =>
            Effect.sync(() => {
              setSettings(value.overlay)
            }),
        }),
        Effect.ensuring(
          Effect.sync(() => {
            setSaving(false)
          }),
        ),
      ),
    )
  }

  return (
    <div className="space-y-2">
      <SettingsBlock title={t('title')}>
        <SettingsRow
          label={t('enable')}
          hint={t('enableHint')}
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
        title={t('games')}
        description={t('gamesDescription')}
      >
        {!settings ? (
          <p className="text-sm text-muted-foreground">{t('loading')}</p>
        ) : games.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-8">
            <Empty size="inline">
              <EmptyDescription>{t('noGames')}</EmptyDescription>
            </Empty>
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
