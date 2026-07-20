import { useEffect } from 'react'
import type {
  NativeDiagnosticIncident,
  NativeDiagnosticIncidentSeverity,
} from '@syrnike13/platform'

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

  useEffect(() => {
    const token = auth.session?.token
    if (!desktop || !token) return
    let active = true
    let draining = false

    const drainNativeIncidents = async () => {
      if (draining) return
      draining = true
      let batchId: string | null = null
      try {
        const batch = await desktop.diagnostics.leaseNativeIncidents()
        if (!batch) return
        batchId = batch.id
        if (!active) {
          await desktop.diagnostics.releaseNativeIncidents(batch.id)
          batchId = null
          return
        }
        const incidents = batch.incidents
        for (const incident of incidents) {
          recordDiagnosticEvent(
            'native-runtime',
            'instability_detected',
            incident,
          )
        }
        const severity = highestIncidentSeverity(incidents)
        const report = await sendDiagnosticReport({
          token,
          desktop,
          area: 'native-runtime',
          severity,
          triggerCode: incidents[0]?.triggerCode ?? 'native_instability',
          context: { incidents },
          automatic: true,
          automaticCooldownMs: 60_000,
        })
        if (report) {
          await desktop.diagnostics.acknowledgeNativeIncidents(batch.id)
        } else {
          await desktop.diagnostics.releaseNativeIncidents(batch.id)
        }
        batchId = null
      } catch {
        if (batchId) {
          await desktop.diagnostics.releaseNativeIncidents(batchId).catch(() => false)
        }
      } finally {
        draining = false
      }
    }

    void drainNativeIncidents()
    const interval = window.setInterval(() => void drainNativeIncidents(), 2_000)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [auth.session?.token, desktop])

  return null
}

function highestIncidentSeverity(incidents: NativeDiagnosticIncident[]) {
  let severity: NativeDiagnosticIncidentSeverity = 'warning'
  for (const incident of incidents) {
    if (incident.severity === 'fatal') return 'fatal'
    if (incident.severity === 'error') severity = 'error'
  }
  return severity
}
