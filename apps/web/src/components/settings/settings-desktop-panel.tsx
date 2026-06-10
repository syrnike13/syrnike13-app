import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { SettingsBlock, SettingsRow } from '#/components/settings/settings-panels'
import { Button } from '#/components/ui/button'
import { Switch } from '#/components/ui/switch'
import { usePlatform } from '#/platform/use-platform'
import type {
  DesktopOverlayPreferences,
  DesktopUpdateState,
  DesktopVersions,
  DesktopWindowPreferences,
} from '@syrnike13/platform'

const DEFAULT_OVERLAY_PREFERENCES: DesktopOverlayPreferences = {
  enabled: true,
  games: [],
}

const DEFAULT_WINDOW_PREFERENCES: DesktopWindowPreferences = {
  closeToTray: true,
  openAtLogin: true,
  overlay: DEFAULT_OVERLAY_PREFERENCES,
}

export function SettingsDesktopPanel() {
  const { desktop } = usePlatform()
  const [versions, setVersions] = useState<DesktopVersions | null>(null)
  const [windowPreferences, setWindowPreferences] =
    useState<DesktopWindowPreferences | null>(null)
  const [updateState, setUpdateState] = useState<DesktopUpdateState | null>(null)
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const [savingCloseToTray, setSavingCloseToTray] = useState(false)
  const [savingOpenAtLogin, setSavingOpenAtLogin] = useState(false)

  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    void desktop.getVersions().then((value) => {
      if (!cancelled) setVersions(value)
    })
    void desktop.window.getPreferences().then((value) => {
      if (!cancelled) setWindowPreferences(value)
    })
    void desktop.updates.getState().then((value) => {
      if (!cancelled) setUpdateState(value)
    })
    const unsubscribe = desktop.updates.onStateChange((value) => {
      if (!cancelled) setUpdateState(value)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [desktop])

  async function checkForUpdates() {
    if (!desktop) return
    setCheckingUpdates(true)
    try {
      setUpdateState(await desktop.updates.check())
    } catch (error) {
      setUpdateState(null)
      toast.error(
        error instanceof Error
          ? error.message
          : 'Не удалось проверить обновления',
      )
    } finally {
      setCheckingUpdates(false)
    }
  }

  return (
    <div className="space-y-2">
      <SettingsBlock title="Приложение">
        <SettingsRow
          label="Версия"
          value={
            versions
              ? `${versions.app} · Electron ${versions.electron}`
              : 'Загрузка…'
          }
        />
        <SettingsRow
          label="Chromium / Node"
          value={
            versions ? `${versions.chrome} / ${versions.node}` : undefined
          }
        />
      </SettingsBlock>

      <SettingsBlock title="Обновления">
        <SettingsRow
          label="Статус"
          value={formatUpdateStatus(updateState)}
        >
          <div className="flex items-center gap-2">
            {updateState?.status === 'ready' ? (
              <Button size="sm" onClick={() => desktop?.updates.install()}>
                Перезапустить
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={checkingUpdates || updateState?.status === 'checking'}
              onClick={() => void checkForUpdates()}
            >
              {checkingUpdates || updateState?.status === 'checking'
                ? 'Проверка…'
                : 'Проверить'}
            </Button>
          </div>
        </SettingsRow>
      </SettingsBlock>

      <SettingsBlock title="Запуск">
        <SettingsRow
          label="Запускать при входе в систему"
          hint="syrnike13 откроется после включения компьютера"
        >
          <Switch
            checked={windowPreferences?.openAtLogin ?? true}
            disabled={!windowPreferences || savingOpenAtLogin}
            onCheckedChange={(checked) => {
              if (!desktop || savingOpenAtLogin) return
              const previous = windowPreferences
              setWindowPreferences((current) => ({
                ...(current ?? DEFAULT_WINDOW_PREFERENCES),
                openAtLogin: checked,
              }))
              setSavingOpenAtLogin(true)
              void desktop.window
                .setOpenAtLogin(checked)
                .then(setWindowPreferences)
                .catch((error) => {
                  setWindowPreferences(previous)
                  toast.error(
                    error instanceof Error
                      ? error.message
                      : 'Не удалось сохранить настройку автозапуска',
                  )
                })
                .finally(() => {
                  setSavingOpenAtLogin(false)
                })
            }}
          />
        </SettingsRow>
      </SettingsBlock>

      <SettingsBlock title="Окно">
        <SettingsRow label="Закрывать в трей">
          <Switch
            checked={windowPreferences?.closeToTray ?? true}
            disabled={!windowPreferences || savingCloseToTray}
            onCheckedChange={(checked) => {
              if (!desktop || savingCloseToTray) return
              const previous = windowPreferences
              setWindowPreferences((current) => ({
                ...(current ?? DEFAULT_WINDOW_PREFERENCES),
                closeToTray: checked,
              }))
              setSavingCloseToTray(true)
              void desktop.window
                .setCloseToTray(checked)
                .then(setWindowPreferences)
                .catch((error) => {
                  setWindowPreferences(previous)
                  toast.error(
                    error instanceof Error
                      ? error.message
                      : 'Не удалось сохранить настройку окна',
                  )
                })
                .finally(() => {
                  setSavingCloseToTray(false)
                })
            }}
          />
        </SettingsRow>
      </SettingsBlock>

      <SettingsBlock title="Активность">
        <SettingsRow
          label="Статус"
          value="Скоро: игра / просмотр / прослушивание"
        />
      </SettingsBlock>
    </div>
  )
}

function formatUpdateStatus(state: DesktopUpdateState | null) {
  if (!state) return 'Загрузка…'

  switch (state.status) {
    case 'idle':
      return 'Установлена последняя версия'
    case 'checking':
      return 'Проверка обновлений…'
    case 'available':
      return `Доступно v${state.version}, загрузка…`
    case 'downloading':
      return `Загрузка… ${Math.round(state.percent)}%`
    case 'ready':
      return `Готово к установке: v${state.version}`
    case 'error':
      return state.message
  }
}
