import { useEffect } from 'react'

import { useAuth } from '#/features/auth/auth-context'
import { usePlatform } from '#/platform/use-platform'
import {
  recordDiagnosticEvent,
  sendDiagnosticReport,
} from './diagnostic-reporter'

export function DiagnosticErrorReporter() {
  const auth = useAuth()
  const { desktop } = usePlatform()

  useEffect(() => {
    const report = (triggerCode: string, error: unknown) => {
      const context = error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { reason: String(error) }
      recordDiagnosticEvent('renderer', triggerCode, context)
      if (!auth.session?.token) return
      void sendDiagnosticReport({
        token: auth.session.token,
        desktop,
        area: 'renderer',
        severity: 'fatal',
        triggerCode,
        context,
        automatic: true,
      }).catch(() => undefined)
    }
    const onError = (event: ErrorEvent) => {
      if (event.error instanceof Error) report('renderer_error', event.error)
    }
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      report('unhandled_rejection', event.reason)
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onUnhandledRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onUnhandledRejection)
    }
  }, [auth.session?.token, desktop])

  return null
}
