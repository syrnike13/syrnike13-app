import { beforeEach, describe, expect, it } from 'vitest'

import {
  captureNativeDiagnosticIncident,
  clearNativeDiagnosticIncidentsForTests,
  takeNativeDiagnosticIncidents,
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

    expect(takeNativeDiagnosticIncidents()).toEqual([
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
    expect(takeNativeDiagnosticIncidents()).toHaveLength(2)
  })

  it('marks contract corruption as fatal', () => {
    captureNativeDiagnosticIncident({
      scope: 'desktop-voice',
      event: 'native_contract_corruption',
    })

    expect(takeNativeDiagnosticIncidents()[0]?.severity).toBe('fatal')
  })
})
