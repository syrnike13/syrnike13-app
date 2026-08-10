import { beforeEach, describe, expect, it } from 'vitest'

import {
  captureNativeDiagnosticIncident,
  clearNativeDiagnosticIncidentsForTests,
  configureNativeDiagnosticIncidentAccount,
  leaseNativeDiagnosticIncidents,
} from './diagnostic-incidents'

describe('screen stream diagnostic incidents', () => {
  beforeEach(() => {
    clearNativeDiagnosticIncidentsForTests()
    configureNativeDiagnosticIncidentAccount('test-account')
  })

  it('uploads a retained-texture stall with bounded numerical evidence', () => {
    captureNativeDiagnosticIncident({
      scope: 'native-video',
      event: 'presentation_stalled',
      kind: 'remote-screen',
      stage: 'renderer-presentation',
      errorCode: 'retained_texture_budget_exhausted',
      incidentSeverity: 'error',
      reason: 'retained-budget-exhausted',
      metrics: {
        retainedFrames: 6,
        retainedBytes: 49_766_400,
        rejectedFrames: 18_000,
        oldestRetainedAgeMs: 600_000,
        invalid: Number.NaN,
      },
    }, 10_000)

    expect(
      leaseNativeDiagnosticIncidents('test-account', 10_000)?.incidents,
    ).toEqual([
      expect.objectContaining({
        severity: 'error',
        triggerCode: 'native-video.retained_texture_budget_exhausted',
        reason: 'retained-budget-exhausted',
        metrics: {
          retainedFrames: 6,
          retainedBytes: 49_766_400,
          rejectedFrames: 18_000,
          oldestRetainedAgeMs: 600_000,
        },
      }),
    ])
  })

  it.each([
    ['remote_video_recovery_degraded', 'native-media-controller'],
    ['screen_pipeline_stalled', 'desktop-voice'],
    ['shared_texture_operation_failed', 'native-video'],
  ] as const)('treats %s as an automatic near-critical incident', (event, scope) => {
    expect(captureNativeDiagnosticIncident({
      scope,
      event,
      kind: 'screen',
    })).toMatchObject({
      severity: 'error',
      event,
    })
  })
})
