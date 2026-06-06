import { useEffect, useState } from 'react'

import { SettingsBlock, SettingsRow } from '#/components/settings/settings-panels'
import { Button } from '#/components/ui/button'
import { Switch } from '#/components/ui/switch'
import { usePlatform } from '#/platform/use-platform'
import type {
  DesktopUpdateState,
  DesktopVersions,
  DesktopWindowPreferences,
} from '@syrnike13/platform'

export function SettingsDesktopPanel() {
  const { desktop } = usePlatform()
  const [versions, setVersions] = useState<DesktopVersions | null>(null)
  const [windowPreferences, setWindowPreferences] =
    useState<DesktopWindowPreferences | null>(null)
  const [updateState, setUpdateState] = useState<DesktopUpdateState | null>(null)
  const [checkingUpdates, setCheckingUpdates] = useState(false)

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
    } finally {
      setCheckingUpdates(false)
    }
  }

  return (
    <div className="space-y-2">
      <SettingsBlock
        title="Приложение"
        description="Настольная оболочка Electron поверх того же интерфейса, что и в браузере."
      >
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

      <SettingsBlock
        title="Обновления"
        description="Фоновая проверка релизов на GitHub и установка при перезапуске."
      >
        <SettingsRow
          label="Статус"
          value={formatUpdateStatus(updateState)}
          hint="Обновления скачиваются автоматически, как в Discord."
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

      <SettingsBlock
        title="Окно"
        description="Поведение настольного окна и системного трея."
      >
        <SettingsRow
          label="Закрывать в трей"
          hint="Кнопка закрытия скрывает окно, а приложение продолжает работать в фоне."
        >
          <Switch
            checked={windowPreferences?.closeToTray ?? true}
            disabled={!windowPreferences}
            onCheckedChange={(checked) => {
              if (!desktop) return
              setWindowPreferences((current) => ({
                ...(current ?? { closeToTray: true }),
                closeToTray: checked,
              }))
              void desktop.window
                .setCloseToTray(checked)
                .then(setWindowPreferences)
            }}
          />
        </SettingsRow>
      </SettingsBlock>

      <SettingsBlock
        title="Активность"
        description="Заглушка для Rich Presence — IPC уже есть, нативный модуль подключим позже."
      >
        <SettingsRow
          label="Статус"
          value="Скоро: игра / просмотр / прослушивание"
          hint="Сейчас события только логируются в main process."
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
