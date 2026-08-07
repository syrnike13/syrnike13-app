import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Effect, Fiber } from 'effect'

import { SettingsBlock, SettingsRow } from '#/components/settings/settings-panels'
import { Button } from '#/components/ui/button'
import { Switch } from '#/components/ui/switch'
import { usePlatform } from '#/platform/use-platform'
import { useAuth } from '#/features/auth/auth-context'
import { sendDiagnosticReport } from '#/features/diagnostics/diagnostic-reporter'
import type {
  DesktopUpdateState,
  DesktopVersions,
  DesktopWindowPreferences,
  DesktopObservabilitySettings,
} from '@syrnike13/platform'

const DEFAULT_WINDOW_PREFERENCES: DesktopWindowPreferences = {
  closeToTray: true,
  openAtLogin: true,
}

const DEFAULT_OBSERVABILITY_SETTINGS: DesktopObservabilitySettings = {
  anonymousNativeMetrics: true,
  diagnosticReports: true,
  nativeCrashReports: false,
}

export function SettingsDesktopPanel() {
  const auth = useAuth()
  const { desktop } = usePlatform()
  const [versions, setVersions] = useState<DesktopVersions | null>(null)
  const [windowPreferences, setWindowPreferences] =
    useState<DesktopWindowPreferences | null>(null)
  const [updateState, setUpdateState] = useState<DesktopUpdateState | null>(null)
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const [savingCloseToTray, setSavingCloseToTray] = useState(false)
  const [savingOpenAtLogin, setSavingOpenAtLogin] = useState(false)
  const [observability, setObservability] =
    useState<DesktopObservabilitySettings | null>(null)
  const [savingObservability, setSavingObservability] = useState(false)
  const [sendingDiagnosticReport, setSendingDiagnosticReport] = useState(false)

  useEffect(() => {
    if (!desktop) return

    let pushedUpdateRevision = 0
    const unsubscribe = desktop.updates.onStateChange((value) => {
      pushedUpdateRevision += 1
      setUpdateState(value)
    })
    const initialUpdateRevision = pushedUpdateRevision
    const fiber = Effect.runFork(
      Effect.all(
        [
          Effect.tryPromise({
            try: () => desktop.getVersions(),
            catch: (cause) => cause,
          }).pipe(
            Effect.tap((value) =>
              Effect.sync(() => {
                setVersions(value)
              }),
            ),
            Effect.ignore,
          ),
          Effect.tryPromise({
            try: () => desktop.window.getPreferences(),
            catch: (cause) => cause,
          }).pipe(
            Effect.tap((value) =>
              Effect.sync(() => {
                setWindowPreferences(value)
              }),
            ),
            Effect.ignore,
          ),
          Effect.tryPromise({
            try: () => desktop.updates.getState(),
            catch: (cause) => cause,
          }).pipe(
            Effect.tap((value) =>
              Effect.sync(() => {
                if (pushedUpdateRevision === initialUpdateRevision) {
                  setUpdateState(value)
                }
              }),
            ),
            Effect.ignore,
          ),
          Effect.tryPromise({
            try: () => desktop.settings.load(),
            catch: (cause) => cause,
          }).pipe(
            Effect.tap((value) =>
              Effect.sync(() => {
                setObservability(value.observability)
              }),
            ),
            Effect.ignore,
          ),
        ],
        { concurrency: 'unbounded', discard: true },
      ),
    )

    return () => {
      unsubscribe()
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [desktop])

  function checkForUpdates() {
    if (!desktop) return
    setCheckingUpdates(true)
    Effect.runFork(
      Effect.tryPromise({
        try: () => desktop.updates.check(),
        catch: (cause) => cause,
      }).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() => {
              setUpdateState(null)
              toast.error(
                error instanceof Error
                  ? error.message
                  : 'Не удалось проверить обновления',
              )
            }),
          onSuccess: (state) =>
            Effect.sync(() => {
              setUpdateState(state)
            }),
        }),
        Effect.ensuring(
          Effect.sync(() => {
            setCheckingUpdates(false)
          }),
        ),
      ),
    )
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
              onClick={checkForUpdates}
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
              Effect.runFork(
                Effect.tryPromise({
                  try: () => desktop.window.setOpenAtLogin(checked),
                  catch: (cause) => cause,
                }).pipe(
                  Effect.matchEffect({
                    onFailure: (error) =>
                      Effect.sync(() => {
                        setWindowPreferences(previous)
                        toast.error(
                          error instanceof Error
                            ? error.message
                            : 'Не удалось сохранить настройку автозапуска',
                        )
                      }),
                    onSuccess: (value) =>
                      Effect.sync(() => {
                        setWindowPreferences(value)
                      }),
                  }),
                  Effect.ensuring(
                    Effect.sync(() => {
                      setSavingOpenAtLogin(false)
                    }),
                  ),
                ),
              )
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
              Effect.runFork(
                Effect.tryPromise({
                  try: () => desktop.window.setCloseToTray(checked),
                  catch: (cause) => cause,
                }).pipe(
                  Effect.matchEffect({
                    onFailure: (error) =>
                      Effect.sync(() => {
                        setWindowPreferences(previous)
                        toast.error(
                          error instanceof Error
                            ? error.message
                            : 'Не удалось сохранить настройку окна',
                        )
                      }),
                    onSuccess: (value) =>
                      Effect.sync(() => {
                        setWindowPreferences(value)
                      }),
                  }),
                  Effect.ensuring(
                    Effect.sync(() => {
                      setSavingCloseToTray(false)
                    }),
                  ),
                ),
              )
            }}
          />
        </SettingsRow>
      </SettingsBlock>

      <SettingsBlock
        title="Конфиденциальность и диагностика"
        description="Эти настройки относятся только к нативным функциям Windows: микрофону, демонстрации экрана, горячим клавишам и оверлею."
      >
        <SettingsRow
          label="Анонимная статистика стабильности"
          hint="Отправляет только агрегированные счётчики запусков, сбоев и времени операций. Не отправляет токены, адреса комнат, ID пользователей, названия окон и устройств, пути, содержимое аудио или экрана."
        >
          <Switch
            checked={
              observability?.anonymousNativeMetrics ??
              DEFAULT_OBSERVABILITY_SETTINGS.anonymousNativeMetrics
            }
            disabled={!observability || savingObservability}
            onCheckedChange={(checked) => {
              void updateObservability({ anonymousNativeMetrics: checked })
            }}
          />
        </SettingsRow>
        <SettingsRow
          label="Автоматические диагностические отчёты"
          hint="При сбое голоса, демонстрации экрана, глобальной ошибке интерфейса или необработанном отклонении Promise отправляет ограниченный структурированный пакет без токенов, адресов комнат, содержимого сообщений, аудио и экрана. Изменение подробных native-логов вступит в силу после перезапуска приложения."
        >
          <Switch
            checked={
              observability?.diagnosticReports ??
              DEFAULT_OBSERVABILITY_SETTINGS.diagnosticReports
            }
            disabled={!observability || savingObservability}
            onCheckedChange={(checked) => {
              void updateObservability({ diagnosticReports: checked })
            }}
          />
        </SettingsRow>
        <SettingsRow
          label="Полные отчёты о сбоях"
          hint="Могут содержать фрагменты памяти процесса. Выключены по умолчанию, отправляются только после вашего согласия. Изменение вступит в силу после перезапуска приложения."
        >
          <Switch
            checked={
              observability?.nativeCrashReports ??
              DEFAULT_OBSERVABILITY_SETTINGS.nativeCrashReports
            }
            disabled={!observability || savingObservability}
            onCheckedChange={(checked) => {
              void updateObservability({ nativeCrashReports: checked })
            }}
          />
        </SettingsRow>
        <SettingsRow
          label="Отправить отчёт сейчас"
          hint="Собирает текущий ограниченный журнал renderer и последние redacted native-логи, затем показывает ID отчёта для обращения в поддержку."
        >
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!auth.session?.token || !desktop || sendingDiagnosticReport}
            onClick={() => {
              if (!auth.session?.token || !desktop) return
              const sessionToken = auth.session.token
              setSendingDiagnosticReport(true)
              Effect.runFork(
                sendDiagnosticReport({
                  token: sessionToken,
                  desktop,
                  area: 'client',
                  severity: 'warning',
                  triggerCode: 'manual_report',
                  description: 'Manual diagnostic report',
                }).pipe(
                  Effect.matchEffect({
                    onFailure: (error) =>
                      Effect.sync(() => {
                        toast.error(
                          error instanceof Error
                            ? error.message
                            : 'Не удалось отправить диагностический отчёт',
                        )
                      }),
                    onSuccess: (report) =>
                      Effect.sync(() => {
                        if (report) {
                          toast.success(`Отчёт отправлен: ${report.id}`)
                        }
                      }),
                  }),
                  Effect.ensuring(
                    Effect.sync(() => {
                      setSendingDiagnosticReport(false)
                    }),
                  ),
                ),
              )
            }}
          >
            {sendingDiagnosticReport ? 'Отправка…' : 'Отправить'}
          </Button>
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

  function updateObservability(
    patch: Partial<DesktopObservabilitySettings>,
  ) {
    if (!desktop || !observability || savingObservability) return
    const previous = observability
    setObservability({ ...observability, ...patch })
    setSavingObservability(true)
    Effect.runFork(
      Effect.tryPromise({
        try: () => desktop.settings.update({ observability: patch }),
        catch: (cause) => cause,
      }).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() => {
              setObservability(previous)
              toast.error(
                error instanceof Error
                  ? error.message
                  : 'Не удалось сохранить настройки диагностики',
              )
            }),
          onSuccess: (settings) =>
            Effect.sync(() => {
              setObservability(settings.observability)
            }),
        }),
        Effect.ensuring(
          Effect.sync(() => {
            setSavingObservability(false)
          }),
        ),
      ),
    )
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
    case 'installing':
      return `Установка v${state.version}…`
    case 'error':
      return state.message
  }
}
