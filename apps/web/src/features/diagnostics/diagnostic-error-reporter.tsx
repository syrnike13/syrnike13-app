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
import {
  enqueueAutomaticDiagnosticIncident,
  subscribeAutomaticDiagnosticIncidents,
} from './automatic-diagnostic-incidents'

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
      enqueueAutomaticDiagnosticIncident({
        area: 'renderer',
        severity: 'fatal',
        triggerCode,
        context,
      })
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
    const accountId = auth.session?.user_id
    if (!token || !accountId) return
    let operation = Promise.resolve()
    let active = true
    const unsubscribe = subscribeAutomaticDiagnosticIncidents((incident) => {
      operation = operation
        .catch(() => undefined)
        .then(async () => {
          if (!active) return
          if (desktop) {
            await desktop.diagnostics.enqueueIncident(accountId, {
              area: incident.area,
              severity: incident.severity,
              triggerCode: incident.triggerCode,
              cooldownMs: incident.cooldownMs,
            })
            return
          }
          await sendDiagnosticReport({
            token,
            desktop,
            area: incident.area,
            severity: incident.severity,
            triggerCode: incident.triggerCode,
            context: incident.context,
            automatic: true,
            automaticCooldownMs: incident.cooldownMs,
          })
        })
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [auth.session?.token, auth.session?.user_id, desktop])

  useEffect(() => {
    const token = auth.session?.token
    const accountId = auth.session?.user_id
    if (!desktop || !token || !accountId) return
    let active = true
    let draining = false

    const drainNativeIncidents = async () => {
      if (draining) return
      draining = true
      let batchId: string | null = null
      try {
        const batch = await desktop.diagnostics.leaseNativeIncidents(accountId)
        if (!batch) return
        batchId = batch.id
        if (!active || batch.accountId !== accountId) {
          if (batch.accountId === accountId) {
            await desktop.diagnostics.releaseNativeIncidents(accountId, batch.id)
          }
          batchId = null
          return
        }
        const incidents = batch.incidents
        for (const incident of incidents) {
          recordDiagnosticEvent(
            'native-runtime',
            'instability_detected',
            incident,
            {
              dedupeKey: `native-runtime:${incident.identity ?? `${incident.scope}:${incident.triggerCode}`}`,
              heartbeatMs: 60_000,
            },
          )
        }
        const severity = highestIncidentSeverity(incidents)
        const report = await sendDiagnosticReport({
          token,
          desktop,
          area: incidents[0]?.area ?? 'native-runtime',
          severity,
          triggerCode: incidents[0]?.triggerCode ?? 'native_instability',
          context: { incidents },
          automatic: true,
          automaticLease: true,
        })
        if (report) {
          await desktop.diagnostics.acknowledgeNativeIncidents(accountId, batch.id)
        } else {
          await desktop.diagnostics.releaseNativeIncidents(accountId, batch.id)
        }
        batchId = null
      } catch {
        if (batchId) {
          await desktop.diagnostics.releaseNativeIncidents(accountId, batchId).catch(() => false)
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
  }, [auth.session?.token, auth.session?.user_id, desktop])

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
