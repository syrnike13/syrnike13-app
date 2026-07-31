export type AutomaticDiagnosticSeverity = 'warning' | 'error' | 'fatal'

export type AutomaticDiagnosticIncident = {
  area: string
  severity: AutomaticDiagnosticSeverity
  triggerCode: string
  context?: unknown
  cooldownMs?: number
}

const MAX_PENDING_INCIDENTS = 100
const pending: AutomaticDiagnosticIncident[] = []
const listeners = new Set<(incident: AutomaticDiagnosticIncident) => void>()

export function enqueueAutomaticDiagnosticIncident(
  incident: AutomaticDiagnosticIncident,
) {
  if (listeners.size === 0) {
    pending.push(incident)
    if (pending.length > MAX_PENDING_INCIDENTS) pending.shift()
    return
  }
  for (const listener of listeners) listener(incident)
}

export function subscribeAutomaticDiagnosticIncidents(
  listener: (incident: AutomaticDiagnosticIncident) => void,
) {
  listeners.add(listener)
  const queued = pending.splice(0, pending.length)
  for (const incident of queued) listener(incident)
  return () => {
    listeners.delete(listener)
  }
}

export function clearPendingAutomaticDiagnosticIncidents() {
  pending.length = 0
}

export function clearAutomaticDiagnosticIncidentsForTests() {
  pending.length = 0
  listeners.clear()
}
