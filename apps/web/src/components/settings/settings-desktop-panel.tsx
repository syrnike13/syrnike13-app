import { useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'

import { SettingsBlock, SettingsRow } from '#/components/settings/settings-panels'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { Switch } from '#/components/ui/switch'
import { usePlatform } from '#/platform/use-platform'
import type {
  ActivityDetails,
  DesktopUpdateState,
  DesktopVersions,
  DesktopWindowPreferences,
} from '@syrnike13/platform'

const DEFAULT_WINDOW_PREFERENCES: DesktopWindowPreferences = {
  closeToTray: true,
  openAtLogin: true,
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
  const [activityType, setActivityType] =
    useState<ActivityDetails['type']>('playing')
  const [activityName, setActivityName] = useState('')
  const [activityDetails, setActivityDetails] = useState('')
  const [activityState, setActivityState] = useState('')
  const [activitySaving, setActivitySaving] = useState(false)
  const [activityPreview, setActivityPreview] = useState<ActivityDetails | null>(
    null,
  )

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

  async function setDesktopActivity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!desktop) return

    const name = activityName.trim()
    if (!name) return

    const nextActivity: ActivityDetails = {
      type: activityType,
      name,
      details: activityDetails.trim() || undefined,
      state: activityState.trim() || undefined,
    }

    setActivitySaving(true)
    try {
      await desktop.activity.set(nextActivity)
      setActivityPreview(nextActivity)
      toast.success('Активность показывается')
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Не удалось показать активность',
      )
    } finally {
      setActivitySaving(false)
    }
  }

  async function clearDesktopActivity() {
    if (!desktop) return

    setActivitySaving(true)
    try {
      await desktop.activity.clear()
      setActivityPreview(null)
      toast.success('Активность скрыта')
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Не удалось скрыть активность',
      )
    } finally {
      setActivitySaving(false)
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
          hint="Показывайте ручной Activity Status в desktop presence."
          stacked
        >
          <form className="w-full space-y-3" onSubmit={setDesktopActivity}>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="desktop-activity-name">
                  Название активности
                </Label>
                <Input
                  id="desktop-activity-name"
                  value={activityName}
                  placeholder="syrnike13"
                  onChange={(event) => setActivityName(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="desktop-activity-details">Детали</Label>
                <Input
                  id="desktop-activity-details"
                  value={activityDetails}
                  placeholder="Настраивает сервер"
                  onChange={(event) => setActivityDetails(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="desktop-activity-state">Состояние</Label>
                <Input
                  id="desktop-activity-state"
                  value={activityState}
                  placeholder="В голосовом канале"
                  onChange={(event) => setActivityState(event.target.value)}
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {ACTIVITY_TYPE_OPTIONS.map((option) => (
                <Button
                  key={option.value}
                  type="button"
                  size="sm"
                  variant={
                    activityType === option.value ? 'secondary' : 'outline'
                  }
                  onClick={() => setActivityType(option.value)}
                >
                  {option.label}
                </Button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="submit"
                size="sm"
                disabled={activitySaving || !activityName.trim()}
              >
                Показать активность
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={activitySaving}
                onClick={() => void clearDesktopActivity()}
              >
                Очистить
              </Button>
              <p className="text-sm text-muted-foreground">
                {activityPreview
                  ? `Показывается: ${activityTypeLabel(activityPreview.type)} ${activityPreview.name}`
                  : 'Активность не показывается'}
              </p>
            </div>
          </form>
        </SettingsRow>
      </SettingsBlock>
    </div>
  )
}

const ACTIVITY_TYPE_OPTIONS: {
  value: ActivityDetails['type']
  label: string
}[] = [
  { value: 'playing', label: 'Играю' },
  { value: 'watching', label: 'Смотрю' },
  { value: 'listening', label: 'Слушаю' },
]

function activityTypeLabel(type: ActivityDetails['type']) {
  switch (type) {
    case 'playing':
      return 'Играет в'
    case 'watching':
      return 'Смотрит'
    case 'listening':
      return 'Слушает'
  }
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
