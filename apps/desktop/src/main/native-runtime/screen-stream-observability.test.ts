import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getVersion: () => '0.6.11' } }))

import {
  AnonymousNativeMetricsReporter,
  recordNativeDiagnosticMetrics,
  recordRendererDiagnosticMetrics,
} from './anonymous-metrics'

function successfulFetchMock() {
  return vi.fn<typeof fetch>(
    async () => new Response(null, { status: 204 }),
  )
}

describe('screen stream anonymous observability', () => {
  it('projects presentation and publisher recovery into the fixed metric schema', async () => {
    const fetchMock = successfulFetchMock()
    const reporter = new AnonymousNativeMetricsReporter({
      appVersion: '0.6.11',
      releaseChannel: 'nightly',
      fetch: fetchMock,
    })
    reporter.configure({
      enabled: true,
      endpoint: 'https://beta.syrnike13.ru/api/telemetry/native',
    })

    recordNativeDiagnosticMetrics({
      scope: 'native-video',
      event: 'presentation_stalled',
      kind: 'remote-screen',
      metrics: { oldestRetainedAgeMs: 7_500 },
    }, reporter)
    recordNativeDiagnosticMetrics({
      scope: 'native-video',
      event: 'presentation_recovery_requested',
      kind: 'remote-screen',
      outcome: 'renderer-reloaded',
      durationMs: 125,
    }, reporter)
    recordNativeDiagnosticMetrics({
      scope: 'desktop-voice',
      event: 'screen_pipeline_stalled',
      kind: 'screen',
    }, reporter)
    recordNativeDiagnosticMetrics({
      scope: 'desktop-voice',
      event: 'screen_republished',
      kind: 'screen',
      durationMs: 900,
    }, reporter)

    await reporter.flush()

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'counter',
        name: 'screen_presentation_stalled',
        sessionKind: 'screen',
      }),
      expect.objectContaining({
        type: 'histogram',
        name: 'screen_retained_texture_age_ms',
        valueMs: 7_500,
      }),
      expect.objectContaining({
        type: 'counter',
        name: 'screen_renderer_reloaded',
      }),
      expect.objectContaining({
        type: 'counter',
        name: 'screen_publisher_stalled',
      }),
      expect.objectContaining({
        type: 'histogram',
        name: 'screen_publisher_republish_ms',
        valueMs: 900,
      }),
    ]))
  })

  it('does not classify camera presentation events as screen metrics', async () => {
    const fetchMock = successfulFetchMock()
    const reporter = new AnonymousNativeMetricsReporter({
      fetch: fetchMock,
    })
    reporter.configure({
      enabled: true,
      endpoint: 'https://syrnike13.ru/api/telemetry/native',
    })

    recordNativeDiagnosticMetrics({
      scope: 'native-video',
      event: 'presentation_stalled',
      kind: 'remote-camera',
    }, reporter)
    await reporter.flush()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('counts every sustained renderer health incident without uploading identifiers', async () => {
    const fetchMock = successfulFetchMock()
    const reporter = new AnonymousNativeMetricsReporter({
      appVersion: '0.6.11',
      releaseChannel: 'stable',
      fetch: fetchMock,
    })
    reporter.configure({
      enabled: true,
      endpoint: 'https://syrnike13.ru/api/telemetry/native',
    })

    const screenCodes = [
      'screen_publication_stalled',
      'screen_subscription_stalled',
      'screen_frames_dropped_critical',
      'screen_renderer_stalled',
      'screen_renderer_frames_dropped_critical',
      'voice_stage_consumer_churn_critical',
    ] as const
    const voiceCodes = [
      'rtc_audio_concealment_critical',
      'rtc_packet_loss_critical',
      'rtc_jitter_critical',
      'rtc_latency_critical',
    ] as const
    for (const triggerCode of screenCodes) {
      recordRendererDiagnosticMetrics({
        area: 'screen',
        severity: 'error',
        triggerCode,
      }, reporter)
    }
    for (const triggerCode of voiceCodes) {
      recordRendererDiagnosticMetrics({
        area: 'voice',
        severity: 'error',
        triggerCode,
      }, reporter)
    }
    await reporter.flush()

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.metrics).toHaveLength(10)
    for (const name of screenCodes) {
      expect(body.metrics).toContainEqual(expect.objectContaining({
        name,
        sessionKind: 'screen',
      }))
    }
    for (const name of voiceCodes) {
      expect(body.metrics).toContainEqual(expect.objectContaining({
        name,
        sessionKind: 'none',
      }))
    }
    expect(JSON.stringify(body)).not.toContain('account')
    expect(JSON.stringify(body)).not.toContain('participant')
  })
})
