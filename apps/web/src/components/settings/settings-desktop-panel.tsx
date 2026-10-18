import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Effect, Fiber } from 'effect'
import { useTranslations, type Translator } from '@syrnike13/ui/i18n'

import { SettingsBlock, SettingsRow } from '#/components/settings/settings-panels'
import { Button } from '@syrnike13/ui/primitives/button'
import { Switch } from '@syrnike13/ui/primitives/switch'
import { usePlatform } from '#/platform/use-platform'
import { useAuth } from '#/features/auth/auth-context'
import { sendDiagnosticReport } from '#/features/diagnostics/diagnostic-reporter'
import { apiErrorMessage } from '#/lib/api/error-message'
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
  const t = useTranslations('settings.desktop')
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
                apiErrorMessage(error, t('checkError')),
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
      <SettingsBlock title={t('app')}>
        <SettingsRow
          label={t('version')}
          value={
            versions
              ? `${versions.app} · Electron ${versions.electron}`
              : t('loading')
          }
        />
        <SettingsRow
          label="Chromium / Node"
          value={
            versions ? `${versions.chrome} / ${versions.node}` : undefined
          }
        />
      </SettingsBlock>

      <SettingsBlock title={t('updates')}>
        <SettingsRow
          label={t('status')}
          value={formatUpdateStatus(updateState, t)}
        >
          <div className="flex items-center gap-2">
            {updateState?.status === 'ready' ? (
              <Button size="sm" onClick={() => desktop?.updates.install()}>
                {t('restart')}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={checkingUpdates || updateState?.status === 'checking'}
              onClick={checkForUpdates}
            >
              {checkingUpdates || updateState?.status === 'checking'
                ? t('checking')
                : t('check')}
            </Button>
          </div>
        </SettingsRow>
      </SettingsBlock>

      <SettingsBlock title={t('startup')}>
        <SettingsRow
          label={t('launchAtLogin')}
          hint={t('launchAtLoginHint')}
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
                          apiErrorMessage(error, t('saveLaunchError')),
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

      <SettingsBlock title={t('window')}>
        <SettingsRow label={t('closeToTray')}>
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
                          apiErrorMessage(error, t('saveWindowError')),
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
        title={t('privacyTitle')}
        description={t('privacyDescription')}
      >
        <SettingsRow
          label={t('anonymousMetrics')}
          hint={t('anonymousMetricsHint')}
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
          label={t('autoReports')}
          hint={t('autoReportsHint')}
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
          label={t('fullCrashReports')}
          hint={t('fullCrashReportsHint')}
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
          label={t('sendReport')}
          hint={t('sendReportHint')}
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
                          apiErrorMessage(error, t('reportError')),
                        )
                      }),
                    onSuccess: (report) =>
                      Effect.sync(() => {
                        if (report) {
                          toast.success(t('reportSent', { id: report.id }))
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
            {sendingDiagnosticReport ? t('sending') : t('send')}
          </Button>
        </SettingsRow>
      </SettingsBlock>

      <SettingsBlock title={t('activity')}>
        <SettingsRow label={t('status')} value={t('activitySoon')} />
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
                apiErrorMessage(error, t('saveDiagnosticsError')),
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

function formatUpdateStatus(state: DesktopUpdateState | null, t: Translator) {
  if (!state) return t('loading')

  switch (state.status) {
    case 'idle':
      return t('updateIdle')
    case 'checking':
      return t('updateChecking')
    case 'available':
      return t('updateAvailable', { version: state.version })
    case 'downloading':
      return t('updateDownloading', {
        percent: Math.round(state.percent),
      })
    case 'ready':
      return t('updateReady', { version: state.version })
    case 'installing':
      return t('updateInstalling', { version: state.version })
    case 'error':
      return state.message
  }
}
