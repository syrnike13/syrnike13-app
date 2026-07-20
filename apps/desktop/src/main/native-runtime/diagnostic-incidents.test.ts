import { beforeEach, describe, expect, it } from 'vitest'

import {
  captureNativeDiagnosticIncident,
  acknowledgeNativeDiagnosticIncidents,
  clearNativeDiagnosticIncidentsForTests,
  leaseNativeDiagnosticIncidents,
  releaseNativeDiagnosticIncidents,
} from './diagnostic-incidents'

describe('native diagnostic incident monitor', () => {
  beforeEach(clearNativeDiagnosticIncidentsForTests)

  it('captures native failures, timeouts, and restart signals', () => {
    captureNativeDiagnosticIncident(
      {
        scope: 'native-runtime-supervisor',
        event: 'request_timed_out',
        runtime: 'media',
        lane: 'microphone',
        timeoutMs: 5_000,
      },
      10_000,
    )
    captureNativeDiagnosticIncident(
      {
        scope: 'native-runtime-supervisor',
        event: 'restart_scheduled',
        restartCount: 1,
      },
      11_000,
    )

    expect(leaseNativeDiagnosticIncidents()?.incidents).toEqual([
      expect.objectContaining({
        severity: 'error',
        triggerCode: 'native-runtime-supervisor.request_timed_out',
        lane: 'microphone',
      }),
      expect.objectContaining({
        severity: 'warning',
        triggerCode: 'native-runtime-supervisor.restart_scheduled',
      }),
    ])
  })

  it('ignores healthy lifecycle noise and deduplicates repeated instability', () => {
    expect(
      captureNativeDiagnosticIncident({
        scope: 'native-runtime-supervisor',
        event: 'request_reply_ok',
      }),
    ).toBeNull()

    const failure = {
      scope: 'native-media-controller' as const,
      event: 'screen_publication_failed',
      errorCode: 'encoder_failed',
    }
    expect(captureNativeDiagnosticIncident(failure, 20_000)).not.toBeNull()
    expect(captureNativeDiagnosticIncident(failure, 21_000)).toBeNull()
    expect(captureNativeDiagnosticIncident(failure, 26_000)).not.toBeNull()
    expect(leaseNativeDiagnosticIncidents()?.incidents).toHaveLength(2)
  })

  it('marks contract corruption as fatal', () => {
    captureNativeDiagnosticIncident({
      scope: 'desktop-voice',
      event: 'native_contract_corruption',
    })

    expect(leaseNativeDiagnosticIncidents()?.incidents[0]?.severity).toBe('fatal')
  })

  it('keeps leased incidents until delivery is acknowledged', () => {
    captureNativeDiagnosticIncident({
      scope: 'desktop-voice',
      event: 'native_contract_corruption',
    })

    const batch = leaseNativeDiagnosticIncidents(10_000)
    expect(batch?.incidents).toHaveLength(1)
    expect(leaseNativeDiagnosticIncidents(10_001)).toEqual(batch)
    expect(releaseNativeDiagnosticIncidents(batch!.id)).toBe(true)

    const retry = leaseNativeDiagnosticIncidents(10_002)
    expect(retry?.incidents).toEqual(batch?.incidents)
    expect(acknowledgeNativeDiagnosticIncidents(retry!.id)).toBe(true)
    expect(leaseNativeDiagnosticIncidents(10_003)).toBeNull()
  })

  it('reclaims an abandoned incident lease', () => {
    captureNativeDiagnosticIncident({
      scope: 'desktop-voice',
      event: 'native_contract_corruption',
    })

    const abandoned = leaseNativeDiagnosticIncidents(10_000)
    const reclaimed = leaseNativeDiagnosticIncidents(10_000 + 2 * 60 * 1_000)
    expect(reclaimed?.id).not.toBe(abandoned?.id)
    expect(reclaimed?.incidents).toEqual(abandoned?.incidents)
  })
})
