import { beforeEach, describe, expect, it } from 'vitest'

import {
  captureNativeDiagnosticIncident,
  captureRendererDiagnosticIncident,
  acknowledgeNativeDiagnosticIncidents,
  clearNativeDiagnosticIncidentsForTests,
  configureNativeDiagnosticIncidentAccount,
  leaseNativeDiagnosticIncidents,
  releaseNativeDiagnosticIncidents,
} from './diagnostic-incidents'

describe('native diagnostic incident monitor', () => {
  beforeEach(() => {
    clearNativeDiagnosticIncidentsForTests()
    configureNativeDiagnosticIncidentAccount('test-account')
  })

  it.each([
    ['request_rejected_queue_full', 'warning'],
    ['restart_scheduled', 'warning'],
    ['runtime_event_dropped_out_of_order', 'warning'],
    ['native_contract_corruption', 'fatal'],
    ['restart_aborted_circuit_open', 'fatal'],
    ['runtime_contract_corrupt', 'fatal'],
    ['utility_crashed', 'fatal'],
    ['adapter_exited', 'error'],
    ['adapter_recycled', 'error'],
    ['bootstrap_failed', 'error'],
    ['dispose_failed', 'error'],
    ['frame_delivery_rejected', 'error'],
    ['handshake_failed', 'error'],
    ['probe_reply_error', 'error'],
    ['probe_timed_out', 'error'],
    ['request_post_failed', 'error'],
    ['request_rejected', 'error'],
    ['request_rejected_not_ready', 'error'],
    ['request_reply_error', 'error'],
    ['request_timed_out', 'error'],
    ['runtime_degraded', 'error'],
    ['screen_publication_failed', 'error'],
    ['session_rotation_failed', 'error'],
  ] as const)(
    'classifies typed automatic trigger %s',
    (event, severity) => {
      expect(captureNativeDiagnosticIncident({
        scope: 'native-runtime-supervisor',
        event,
      }, 10_000)).toMatchObject({
        severity,
        triggerCode: `native-runtime-supervisor.${event}`,
      })
    },
  )

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

    expect(leaseNativeDiagnosticIncidents('test-account')?.incidents).toEqual([
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

  it('ignores healthy lifecycle noise and aggregates repeated typed incidents', () => {
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
    expect(captureNativeDiagnosticIncident(failure, 21_000)).toMatchObject({
      occurrenceCount: 2,
      firstTimestampMs: 20_000,
      timestampMs: 21_000,
    })
    expect(captureNativeDiagnosticIncident(failure, 26_000)).not.toBeNull()
    expect(leaseNativeDiagnosticIncidents('test-account')?.incidents).toHaveLength(2)
  })

  it('uses opaque stable correlation without exposing request identity', () => {
    const first = captureNativeDiagnosticIncident({
      scope: 'native-runtime-supervisor',
      event: 'request_timed_out',
      requestId: 'sensitive-request-id',
      lane: 'screen',
    })
    const second = captureNativeDiagnosticIncident({
      scope: 'native-runtime-supervisor',
      event: 'request_timed_out',
      requestId: 'sensitive-request-id',
      lane: 'screen',
    })

    expect(first?.correlationId).toMatch(/^incident-/)
    expect(second?.correlationId).toBe(first?.correlationId)
    expect(JSON.stringify(first)).not.toContain('sensitive-request-id')
    expect(first?.identity).toContain('request_timed_out')
  })

  it('treats stale generations and projected voice snapshots as non-incidents', () => {
    expect(captureNativeDiagnosticIncident({
      scope: 'native-runtime-supervisor',
      event: 'request_reply_error',
      errorCode: 'stale_generation',
    })).toBeNull()
    expect(captureNativeDiagnosticIncident({
      scope: 'desktop-voice',
      event: 'snapshot',
      errorCode: 'runtime_lost',
    })).toBeNull()
  })

  it('keeps renderer cooldown and upload lease ownership in electron main', () => {
    expect(captureRendererDiagnosticIncident({
      area: 'voice',
      severity: 'error',
      triggerCode: 'runtime_lost',
      cooldownMs: 60_000,
    }, 10_000)).toBe(true)
    const first = leaseNativeDiagnosticIncidents('test-account', 10_000)
    expect(first?.incidents).toEqual([
      expect.objectContaining({
        area: 'voice',
        identity: 'renderer:voice:runtime_lost',
      }),
    ])
    expect(acknowledgeNativeDiagnosticIncidents('test-account', first!.id, 10_000)).toBe(true)

    captureRendererDiagnosticIncident({
      area: 'voice',
      severity: 'error',
      triggerCode: 'runtime_lost',
      cooldownMs: 60_000,
    }, 11_000)
    expect(leaseNativeDiagnosticIncidents('test-account', 11_000)).toBeNull()
    expect(leaseNativeDiagnosticIncidents('test-account', 70_000)?.incidents).toHaveLength(1)
  })

  it('keeps renderer repeats after the IPC-cloned active lease as a follow-up', () => {
    configureNativeDiagnosticIncidentAccount('account-a')
    captureRendererDiagnosticIncident({
      area: 'voice',
      severity: 'error',
      triggerCode: 'runtime_lost',
    }, 10_000)
    const leased = leaseNativeDiagnosticIncidents('account-a', 10_000)!
    const rendererClone = structuredClone(leased)

    expect(captureRendererDiagnosticIncident({
      area: 'voice',
      severity: 'error',
      triggerCode: 'runtime_lost',
    }, 11_000)).toBe(true)
    expect(captureRendererDiagnosticIncident({
      area: 'voice',
      severity: 'error',
      triggerCode: 'runtime_lost',
    }, 12_000)).toBe(true)
    expect(rendererClone.incidents[0]).toMatchObject({
      firstTimestampMs: 10_000,
      timestampMs: 10_000,
      occurrenceCount: 1,
    })
    expect(leased.incidents[0]).toEqual(rendererClone.incidents[0])
    expect(acknowledgeNativeDiagnosticIncidents('account-a', leased.id, 12_000)).toBe(true)
    expect(leaseNativeDiagnosticIncidents('account-a', 10 * 60 * 1_000 + 11_999)).toBeNull()
    expect(
      leaseNativeDiagnosticIncidents('account-a', 10 * 60 * 1_000 + 12_000)?.incidents,
    ).toEqual([
      expect.objectContaining({
        firstTimestampMs: 11_000,
        timestampMs: 12_000,
        occurrenceCount: 2,
      }),
    ])
  })

  it('releases the original lease alongside its bounded follow-up without duplication', () => {
    const failure = {
      scope: 'native-runtime-supervisor' as const,
      event: 'request_timed_out',
      requestId: 'request-a',
    }
    captureNativeDiagnosticIncident(failure, 10_000)
    const leased = leaseNativeDiagnosticIncidents('test-account', 10_000)!
    captureNativeDiagnosticIncident(failure, 11_000)

    expect(releaseNativeDiagnosticIncidents('test-account', leased.id, 11_000)).toBe(true)
    expect(leaseNativeDiagnosticIncidents('test-account', 15_999)).toBeNull()
    const retry = leaseNativeDiagnosticIncidents('test-account', 16_000)!
    expect(retry.incidents).toHaveLength(2)
    expect(retry.incidents.map((incident) => ({
      firstTimestampMs: incident.firstTimestampMs,
      occurrenceCount: incident.occurrenceCount,
    }))).toEqual([
      { firstTimestampMs: 10_000, occurrenceCount: 1 },
      { firstTimestampMs: 11_000, occurrenceCount: 1 },
    ])
  })

  it('retires every incident state on account change but preserves token refresh', () => {
    configureNativeDiagnosticIncidentAccount('account-a')
    captureRendererDiagnosticIncident({
      area: 'voice',
      severity: 'error',
      triggerCode: 'runtime_lost',
      cooldownMs: 60_000,
    }, 10_000)
    const acknowledged = leaseNativeDiagnosticIncidents('account-a', 10_000)!
    expect(acknowledgeNativeDiagnosticIncidents('account-a', acknowledged.id, 10_000)).toBe(true)
    captureRendererDiagnosticIncident({
      area: 'voice',
      severity: 'error',
      triggerCode: 'runtime_lost',
      cooldownMs: 60_000,
    }, 11_000)

    configureNativeDiagnosticIncidentAccount('account-a')
    expect(leaseNativeDiagnosticIncidents('account-a', 11_000)).toBeNull()

    configureNativeDiagnosticIncidentAccount('account-b')
    expect(leaseNativeDiagnosticIncidents('account-b', 70_000)).toBeNull()
    captureRendererDiagnosticIncident({
      area: 'voice',
      severity: 'error',
      triggerCode: 'runtime_lost',
      cooldownMs: 60_000,
    }, 12_000)
    const accountB = leaseNativeDiagnosticIncidents('account-b', 12_000)!
    expect(accountB.incidents).toHaveLength(1)
    expect(accountB.accountId).toBe('account-b')

    configureNativeDiagnosticIncidentAccount(null)
    expect(acknowledgeNativeDiagnosticIncidents('account-b', accountB.id, 12_000)).toBe(false)
    expect(captureNativeDiagnosticIncident({
      scope: 'native-runtime-supervisor',
      event: 'runtime_degraded',
    }, 13_000)).toBeNull()
    expect(captureRendererDiagnosticIncident({
      area: 'voice',
      severity: 'error',
      triggerCode: 'runtime_lost',
    }, 13_000)).toBe(false)
  })

  it('rejects a stale renderer A while account B owns the diagnostic queue', () => {
    configureNativeDiagnosticIncidentAccount('account-a')
    captureRendererDiagnosticIncident({
      area: 'voice',
      severity: 'error',
      triggerCode: 'runtime_lost',
    }, 10_000)
    const batchA = leaseNativeDiagnosticIncidents('account-a', 10_000)!
    expect(batchA.accountId).toBe('account-a')

    configureNativeDiagnosticIncidentAccount('account-b')
    expect(leaseNativeDiagnosticIncidents('account-a', 10_001)).toBeNull()
    expect(
      acknowledgeNativeDiagnosticIncidents('account-a', batchA.id, 10_001),
    ).toBe(false)
    expect(
      releaseNativeDiagnosticIncidents('account-a', batchA.id, 10_001),
    ).toBe(false)

    captureRendererDiagnosticIncident({
      area: 'voice',
      severity: 'error',
      triggerCode: 'runtime_lost',
    }, 10_002)
    const batchB = leaseNativeDiagnosticIncidents('account-b', 10_002)!
    expect(batchB.accountId).toBe('account-b')
    expect(
      acknowledgeNativeDiagnosticIncidents('account-a', batchB.id, 10_003),
    ).toBe(false)
    expect(
      releaseNativeDiagnosticIncidents('account-a', batchB.id, 10_003),
    ).toBe(false)
    expect(
      acknowledgeNativeDiagnosticIncidents('account-b', batchB.id, 10_003),
    ).toBe(true)
  })

  it('adopts bootstrap incidents only into the first loaded account', () => {
    clearNativeDiagnosticIncidentsForTests()
    captureNativeDiagnosticIncident({
      scope: 'native-runtime-supervisor',
      event: 'bootstrap_failed',
    }, 10_000)

    configureNativeDiagnosticIncidentAccount('account-a')
    expect(leaseNativeDiagnosticIncidents('account-a', 10_000)?.incidents).toHaveLength(1)
  })

  it('caps renderer fingerprints with the same bounded TTL index as native incidents', () => {
    configureNativeDiagnosticIncidentAccount('account-a')
    for (let index = 0; index <= 1_000; index += 1) {
      captureRendererDiagnosticIncident({
        area: 'renderer',
        severity: 'error',
        triggerCode: `failure-${index}`,
      }, 10_000)
    }
    captureRendererDiagnosticIncident({
      area: 'renderer',
      severity: 'error',
      triggerCode: 'failure-0',
    }, 11_000)

    expect(
      leaseNativeDiagnosticIncidents('account-a', 11_000)?.incidents.some(
        (incident) => incident.identity === 'renderer:renderer:failure-0',
      ),
    ).toBe(true)
  })

  it('rejects malformed renderer incident summaries', () => {
    expect(captureRendererDiagnosticIncident({
      area: 'voice',
      severity: 'unexpected',
      triggerCode: 'runtime_lost',
    })).toBe(false)
  })

  it('marks contract corruption as fatal', () => {
    captureNativeDiagnosticIncident({
      scope: 'desktop-voice',
      event: 'native_contract_corruption',
    })

    expect(leaseNativeDiagnosticIncidents('test-account')?.incidents[0]?.severity).toBe('fatal')
  })

  it('keeps leased incidents until delivery is acknowledged', () => {
    captureNativeDiagnosticIncident({
      scope: 'desktop-voice',
      event: 'native_contract_corruption',
    })

    const batch = leaseNativeDiagnosticIncidents('test-account', 10_000)
    expect(batch?.incidents).toHaveLength(1)
    expect(leaseNativeDiagnosticIncidents('test-account', 10_001)).toEqual(batch)
    expect(releaseNativeDiagnosticIncidents('test-account', batch!.id, 10_002)).toBe(true)
    expect(leaseNativeDiagnosticIncidents('test-account', 10_003)).toBeNull()

    const retry = leaseNativeDiagnosticIncidents('test-account', 15_002)
    expect(retry?.incidents).toEqual(batch?.incidents)
    expect(acknowledgeNativeDiagnosticIncidents('test-account', retry!.id, 15_002)).toBe(true)
    expect(leaseNativeDiagnosticIncidents('test-account', 15_003)).toBeNull()
  })

  it('backs off an abandoned incident lease before retrying it', () => {
    captureNativeDiagnosticIncident({
      scope: 'desktop-voice',
      event: 'native_contract_corruption',
    })

    const abandoned = leaseNativeDiagnosticIncidents('test-account', 10_000)
    expect(
      leaseNativeDiagnosticIncidents('test-account', 10_000 + 2 * 60 * 1_000),
    ).toBeNull()
    const reclaimed = leaseNativeDiagnosticIncidents(
      'test-account',
      10_000 + 2 * 60 * 1_000 + 5_000,
    )
    expect(reclaimed?.id).not.toBe(abandoned?.id)
    expect(reclaimed?.incidents).toEqual(abandoned?.incidents)
  })

  it('uses bounded retry backoff and resets it after acknowledgement', () => {
    captureNativeDiagnosticIncident({
      scope: 'native-runtime-supervisor',
      event: 'request_timed_out',
    }, 10_000)
    const first = leaseNativeDiagnosticIncidents('test-account', 10_000)!
    expect(releaseNativeDiagnosticIncidents('test-account', first.id, 10_000)).toBe(true)
    expect(leaseNativeDiagnosticIncidents('test-account', 14_999)).toBeNull()

    const second = leaseNativeDiagnosticIncidents('test-account', 15_000)!
    expect(releaseNativeDiagnosticIncidents('test-account', second.id, 15_000)).toBe(true)
    expect(leaseNativeDiagnosticIncidents('test-account', 29_999)).toBeNull()
    const third = leaseNativeDiagnosticIncidents('test-account', 30_000)!
    expect(acknowledgeNativeDiagnosticIncidents('test-account', third.id, 30_000)).toBe(true)

    captureNativeDiagnosticIncident({
      scope: 'native-runtime-supervisor',
      event: 'request_timed_out',
    }, 90_000)
    const afterAck = leaseNativeDiagnosticIncidents('test-account', 90_000)!
    expect(releaseNativeDiagnosticIncidents('test-account', afterAck.id, 90_000)).toBe(true)
    expect(leaseNativeDiagnosticIncidents('test-account', 94_999)).toBeNull()
    expect(leaseNativeDiagnosticIncidents('test-account', 95_000)?.incidents).toHaveLength(1)
  })
})
