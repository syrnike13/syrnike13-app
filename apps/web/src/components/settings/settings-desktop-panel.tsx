import { useEffect, useState } from 'react'

import { SettingsBlock, SettingsRow } from '#/components/settings/settings-panels'
import { usePlatform } from '#/platform/use-platform'
import type { DesktopVersions } from '@syrnike13/platform'

export function SettingsDesktopPanel() {
  const { desktop } = usePlatform()
  const [versions, setVersions] = useState<DesktopVersions | null>(null)

  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    void desktop.getVersions().then((value) => {
      if (!cancelled) setVersions(value)
    })
    return () => {
      cancelled = true
    }
  }, [desktop])

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
