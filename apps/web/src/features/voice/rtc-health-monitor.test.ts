import { describe, expect, it } from 'vitest'

import {
  RtcHealthMonitor,
  type RtcHealthIncident,
} from './rtc-health-monitor'
import type { RtcDebugSnapshot } from './voice-rtc-debug'

describe('RtcHealthMonitor', () => {
  it('reports sustained screen drops with bounded metric context', () => {
    const monitor = new RtcHealthMonitor()
    const sample = snapshot({
      framesDroppedPercent: 35,
      framesDroppedPerSecond: 12,
    })

    expect(monitor.observe(sample).incidents).toEqual([])
    expect(monitor.observe(sample).incidents).toEqual([])
    expect(monitor.observe(sample).incidents).toEqual([
      expect.objectContaining({
        area: 'screen',
        triggerCode: 'screen_frames_dropped_critical',
        context: expect.objectContaining({
          consecutiveSamples: 3,
          quality: expect.objectContaining({
            framesDroppedPercent: 35,
            framesDroppedPerSecond: 12,
          }),
        }),
      }),
    ])
    expect(monitor.observe(sample).incidents).toEqual([])
  })

  it('requires sustained degradation and rearms only after recovery', () => {
    const monitor = new RtcHealthMonitor()
    const degraded = snapshot({ concealedAudioPercent: 40 })
    const healthy = snapshot({})

    monitor.observe(degraded)
    expect(monitor.observe(healthy)).toEqual({
      incidents: [],
      recovered: [],
    })
    monitor.observe(degraded)
    monitor.observe(degraded)
    expect(codes(monitor.observe(degraded))).toEqual([
      'rtc_audio_concealment_critical',
    ])
    expect(monitor.observe(healthy).recovered).toEqual([
      'rtc_audio_concealment_critical',
    ])
    monitor.observe(degraded)
    monitor.observe(degraded)
    expect(codes(monitor.observe(degraded))).toEqual([
      'rtc_audio_concealment_critical',
    ])
  })

  it('reports publisher and subscriber stalls independently', () => {
    const monitor = new RtcHealthMonitor()
    const sample = snapshot({}, {
      localStalled: true,
      remoteStalled: true,
    })

    monitor.observe(sample)
    monitor.observe(sample)
    expect(codes(monitor.observe(sample))).toEqual([
      'screen_publication_stalled',
      'screen_subscription_stalled',
    ])
  })

  it.each([
    [
      'rtc_packet_loss_critical',
      { packetLossPercent: 10 },
      {},
    ],
    [
      'rtc_jitter_critical',
      { jitterMs: 100 },
      {},
    ],
    [
      'rtc_latency_critical',
      {},
      { pingMs: 400 },
    ],
  ] satisfies ReadonlyArray<[
    RtcHealthIncident['triggerCode'],
    NonNullable<RtcDebugSnapshot['rates']>['quality'],
    { pingMs?: number },
  ]>)('reports sustained %s at its critical threshold', (
    triggerCode,
    quality,
    options,
  ) => {
    const monitor = new RtcHealthMonitor()
    const degraded = snapshot(quality, options)

    expect(codes(monitor.observe(degraded))).toEqual([])
    expect(codes(monitor.observe(degraded))).toEqual([])
    expect(codes(monitor.observe(degraded))).toEqual([triggerCode])
  })

  it('does not report a one-sample network spike', () => {
    const monitor = new RtcHealthMonitor()

    monitor.observe(snapshot({ packetLossPercent: 50 }))
    monitor.observe(snapshot({}))

    expect(monitor.observe(snapshot({ packetLossPercent: 50 })).incidents)
      .toEqual([])
  })

  it('reports sustained renderer lag with renderer counters in context', () => {
    const monitor = new RtcHealthMonitor()
    const degraded = snapshot({
      rendererFramesDroppedPercent: 40,
      rendererFramesDroppedPerSecond: 12,
      rendererConsumerChurnPerSecond: 8,
    }, {
      rendererStalled: true,
    })

    monitor.observe(degraded)
    monitor.observe(degraded)
    expect(monitor.observe(degraded).incidents).toEqual([
      expect.objectContaining({
        triggerCode: 'screen_renderer_stalled',
        context: expect.objectContaining({
          screens: expect.objectContaining({ rendererStalled: 1 }),
          renderer: expect.objectContaining({
            framesReceived: 300,
            framesDrawn: 120,
            framesSuperseded: 90,
            activeConsumers: 1,
          }),
        }),
      }),
      expect.objectContaining({
        triggerCode: 'screen_renderer_frames_dropped_critical',
      }),
      expect.objectContaining({
        triggerCode: 'voice_stage_consumer_churn_critical',
      }),
    ])
  })
})

function codes(observation: { incidents: RtcHealthIncident[] }) {
  return observation.incidents.map((incident) => incident.triggerCode)
}

function snapshot(
  quality: NonNullable<RtcDebugSnapshot['rates']>['quality'],
  options: {
    localStalled?: boolean
    remoteStalled?: boolean
    rendererStalled?: boolean
    pingMs?: number
  } = {},
): RtcDebugSnapshot {
  return {
    timestamp: 1,
    transport: { pingMs: options.pingMs },
    outbound: [],
    inbound: [],
    rates: {
      transport: {},
      outbound: {},
      inbound: {},
      quality,
    },
    screenShares: [
      {
        id: 'local',
        ownerUserId: 'local',
        isLocal: true,
        live: true,
        trackReady: true,
        captureVideoPublished: true,
        captureVideoFrames: options.localStalled ? 0 : 30,
        hybridDxgiFrames: 0,
        hybridGdiBitBltFrames: 'N/A',
        hybridGdiPrintWindowFrames: 'N/A',
        hybridGraphicsCaptureFrames: 0,
        hybridVideohookFrames: 'N/A',
      },
      {
        id: 'remote',
        ownerUserId: 'remote',
        isLocal: false,
        live: true,
        subscribed: true,
        trackReady: !options.remoteStalled,
        rendererFramesReceived: options.rendererStalled ? 300 : undefined,
        rendererFramesDrawn: options.rendererStalled ? 120 : undefined,
        rendererFramesSuperseded: options.rendererStalled ? 90 : undefined,
        rendererFramesDroppedNoConsumer: options.rendererStalled ? 10 : undefined,
        rendererFramesDroppedHidden: options.rendererStalled ? 2 : undefined,
        rendererFramesDroppedStale: options.rendererStalled ? 4 : undefined,
        rendererDrawFailures: options.rendererStalled ? 3 : undefined,
        rendererCanvasAttachCount: options.rendererStalled ? 20 : undefined,
        rendererCanvasDetachCount: options.rendererStalled ? 19 : undefined,
        rendererActiveConsumers: options.rendererStalled ? 1 : undefined,
        rendererCanvasPixels: options.rendererStalled ? 1920 * 1080 : undefined,
        rendererFrameWidth: options.rendererStalled ? 1920 : undefined,
        rendererFrameHeight: options.rendererStalled ? 1080 : undefined,
        rendererLastFrameAgeMs: options.rendererStalled ? 100 : undefined,
        rendererLastDrawAgeMs: options.rendererStalled ? 6_000 : undefined,
        hybridDxgiFrames: 'N/A',
        hybridGdiBitBltFrames: 'N/A',
        hybridGdiPrintWindowFrames: 'N/A',
        hybridGraphicsCaptureFrames: 'N/A',
        hybridVideohookFrames: 'N/A',
      },
    ],
  }
}
