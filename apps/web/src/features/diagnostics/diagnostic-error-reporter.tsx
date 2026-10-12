import { useEffect } from 'react'
import type {
  NativeDiagnosticIncident,
  NativeDiagnosticIncidentSeverity,
} from '@syrnike13/platform'
import { Effect, Fiber, Queue, Schedule } from 'effect'

import { useAuth } from '#/features/auth/auth-context'
import { usePlatform } from '#/platform/use-platform'
import {
  recordDiagnosticEvent,
  sendDiagnosticReport,
} from './diagnostic-reporter'
import {
  type AutomaticDiagnosticIncident,
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

    const reportIncident = Effect.fn('diagnostics.reportAutomaticIncident')(
      function*(incident: AutomaticDiagnosticIncident) {
        if (desktop) {
          yield* Effect.tryPromise({
            try: () =>
              desktop.diagnostics.enqueueIncident(accountId, {
                area: incident.area,
                severity: incident.severity,
                triggerCode: incident.triggerCode,
                cooldownMs: incident.cooldownMs,
              }),
            catch: (cause) => cause,
          })
          return
        }
        yield* sendDiagnosticReport({
          token,
          desktop,
          area: incident.area,
          severity: incident.severity,
          triggerCode: incident.triggerCode,
          context: incident.context,
          automatic: true,
          automaticCooldownMs: incident.cooldownMs,
        })
      },
    )

    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function*() {
          const incidents = yield* Queue.unbounded<AutomaticDiagnosticIncident>()
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              subscribeAutomaticDiagnosticIncidents((incident) => {
                Queue.offerUnsafe(incidents, incident)
              }),
            ),
            (unsubscribe) => Effect.sync(unsubscribe),
          )
          yield* Effect.forever(
            Queue.take(incidents).pipe(
              Effect.flatMap(reportIncident),
              Effect.ignore,
            ),
          )
        }),
      ),
    )

    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [auth.session?.token, auth.session?.user_id, desktop])

  useEffect(() => {
    const token = auth.session?.token
    const accountId = auth.session?.user_id
    if (!desktop || !token || !accountId) return

    type NativeIncidentBatch = Awaited<
      ReturnType<typeof desktop.diagnostics.leaseNativeIncidents>
    >
    const leaseNativeIncidents = Effect.callback<
      NativeIncidentBatch,
      unknown
    >((resume) => {
      let cancelled = false
      void desktop.diagnostics.leaseNativeIncidents(accountId).then(
        (batch) => {
          if (!cancelled) {
            resume(Effect.succeed(batch))
            return
          }
          if (batch?.accountId !== accountId) return
          Effect.runFork(
            Effect.tryPromise({
              try: () =>
                desktop.diagnostics.releaseNativeIncidents(
                  accountId,
                  batch.id,
                ),
              catch: (cause) => cause,
            }).pipe(Effect.ignore),
          )
        },
        (cause) => {
          if (!cancelled) resume(Effect.fail(cause))
        },
      )
      return Effect.sync(() => {
        cancelled = true
      })
    })

    const drainNativeIncidents = Effect.gen(function*() {
      let settled = false
      const batch = yield* leaseNativeIncidents
      if (!batch) return

      yield* Effect.acquireUseRelease(
        Effect.succeed(batch),
        (leasedBatch) =>
          Effect.gen(function*() {
            if (leasedBatch.accountId !== accountId) {
              settled = true
              return
            }

            const incidents = leasedBatch.incidents
            yield* Effect.sync(() => {
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
            })
            const severity = highestIncidentSeverity(incidents)
            const report = yield* sendDiagnosticReport({
              token,
              desktop,
              area: incidents[0]?.area ?? 'native-runtime',
              severity,
              triggerCode:
                incidents[0]?.triggerCode ?? 'native_instability',
              context: { incidents },
              automatic: true,
              automaticLease: true,
            })
            yield* Effect.uninterruptible(
              Effect.tryPromise({
                try: () =>
                  report
                    ? desktop.diagnostics.acknowledgeNativeIncidents(
                        accountId,
                        leasedBatch.id,
                      )
                    : desktop.diagnostics.releaseNativeIncidents(
                        accountId,
                        leasedBatch.id,
                      ),
                catch: (cause) => cause,
              }),
            )
            settled = true
          }),
        (leasedBatch) =>
          settled || leasedBatch.accountId !== accountId
            ? Effect.void
            : Effect.tryPromise({
                try: () =>
                  desktop.diagnostics.releaseNativeIncidents(
                    accountId,
                    leasedBatch.id,
                  ),
                catch: (cause) => cause,
              }).pipe(Effect.ignore),
      )
    }).pipe(Effect.catch(() => Effect.void))

    const fiber = Effect.runFork(
      drainNativeIncidents.pipe(
        Effect.repeat(Schedule.spaced(2_000)),
        Effect.asVoid,
      ),
    )

    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
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
