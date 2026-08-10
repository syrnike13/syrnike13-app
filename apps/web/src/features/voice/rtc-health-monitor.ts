import type { RtcDebugSnapshot } from './voice-rtc-debug'

const REQUIRED_CONSECUTIVE_SAMPLES = 3

const THRESHOLDS = {
  framesDroppedPercent: 20,
  framesDroppedPerSecond: 5,
  concealedAudioPercent: 20,
  packetLossPercent: 10,
  jitterMs: 100,
  pingMs: 400,
  rendererFramesDroppedPercent: 20,
  rendererFramesDroppedPerSecond: 5,
  rendererConsumerChurnPerSecond: 4,
  rendererDrawFailuresPerSecond: 1,
  rendererStallMs: 5_000,
} as const

export type RtcHealthIncident = {
  area: 'screen' | 'voice'
  severity: 'error'
  triggerCode:
    | 'screen_publication_stalled'
    | 'screen_subscription_stalled'
    | 'screen_frames_dropped_critical'
    | 'screen_renderer_stalled'
    | 'screen_renderer_frames_dropped_critical'
    | 'voice_stage_consumer_churn_critical'
    | 'rtc_audio_concealment_critical'
    | 'rtc_packet_loss_critical'
    | 'rtc_jitter_critical'
    | 'rtc_latency_critical'
  context: RtcHealthIncidentContext
}

export type RtcHealthObservation = {
  incidents: RtcHealthIncident[]
  recovered: RtcHealthIncident['triggerCode'][]
}

type RtcHealthIncidentContext = {
  consecutiveSamples: number
  thresholds: typeof THRESHOLDS
  quality: {
    framesDroppedPercent?: number
    framesDroppedPerSecond?: number
    concealedAudioPercent?: number
    packetLossPercent?: number
    jitterMs?: number
    pingMs?: number
    rendererFramesDroppedPercent?: number
    rendererFramesDroppedPerSecond?: number
    rendererConsumerChurnPerSecond?: number
    rendererDrawFailuresPerSecond?: number
  }
  screens: {
    localLive: number
    remoteLive: number
    localStalled: number
    remoteStalled: number
    rendererStalled: number
  }
  renderer?: {
    framesReceived: number
    framesDrawn: number
    framesSuperseded: number
    framesDroppedNoConsumer: number
    framesDroppedHidden: number
    framesDroppedStale: number
    drawFailures: number
    canvasAttachCount: number
    canvasDetachCount: number
    activeConsumers: number
    canvasPixels: number
    maxFrameWidth?: number
    maxFrameHeight?: number
    maxLastFrameAgeMs?: number
    maxLastDrawAgeMs?: number
  }
  nativeCapture?: {
    videoFrames?: number
    videoNoFrameCount?: number
    encoderBackpressureTicks?: number
    gpuFramesDroppedStale?: number
    previewFramesDroppedStale?: number
    gpuSlotTimeouts?: number
    previewSlotTimeouts?: number
    rtpFramesEncoded?: number
    rtpFramesSent?: number
    audioFrames?: number
    audioPackets?: number
  }
}

type Condition = {
  area: RtcHealthIncident['area']
  code: RtcHealthIncident['triggerCode']
  active: boolean
}

export class RtcHealthMonitor {
  private readonly consecutive = new Map<
    RtcHealthIncident['triggerCode'],
    number
  >()
  private readonly reported = new Set<RtcHealthIncident['triggerCode']>()

  observe(snapshot: RtcDebugSnapshot): RtcHealthObservation {
    const conditions = healthConditions(snapshot)
    const context = healthContext(snapshot)
    const incidents: RtcHealthIncident[] = []
    const recovered: RtcHealthIncident['triggerCode'][] = []

    for (const condition of conditions) {
      if (!condition.active) {
        this.consecutive.delete(condition.code)
        if (this.reported.delete(condition.code)) recovered.push(condition.code)
        continue
      }
      const consecutive = (this.consecutive.get(condition.code) ?? 0) + 1
      this.consecutive.set(condition.code, consecutive)
      if (
        consecutive < REQUIRED_CONSECUTIVE_SAMPLES ||
        this.reported.has(condition.code)
      ) {
        continue
      }
      this.reported.add(condition.code)
      incidents.push({
        area: condition.area,
        severity: 'error',
        triggerCode: condition.code,
        context: {
          ...context,
          consecutiveSamples: consecutive,
        },
      })
    }

    return { incidents, recovered }
  }

  reset() {
    this.consecutive.clear()
    this.reported.clear()
  }
}

function healthConditions(snapshot: RtcDebugSnapshot): Condition[] {
  const localScreens = snapshot.screenShares.filter(
    (screen) => screen.isLocal && screen.live,
  )
  const remoteScreens = snapshot.screenShares.filter(
    (screen) => !screen.isLocal && screen.live && screen.subscribed === true,
  )
  const localStalled = localScreens.some(
    (screen) =>
      (screen.captureVideoPublished === true &&
        screen.captureVideoFrames === 0) ||
      (screen.captureVideoNoFrameCount ?? 0) >= 3 ||
      (screen.sentBitrate != null &&
        screen.sentBitrate <= 1_000 &&
        screen.fps === 0),
  )
  const remoteStalled = remoteScreens.some(
    (screen) =>
      !screen.trackReady ||
      (screen.receivedBitrate != null &&
        screen.receivedBitrate <= 1_000 &&
        (screen.fps ?? 0) === 0),
  )
  const quality = snapshot.rates?.quality
  const screenDropsCritical =
    remoteScreens.length > 0 &&
    (quality?.framesDroppedPercent ?? 0) >=
      THRESHOLDS.framesDroppedPercent &&
    (quality?.framesDroppedPerSecond ?? 0) >=
      THRESHOLDS.framesDroppedPerSecond
  const rendererStalled = remoteScreens.some(isRendererStalled)
  const rendererDropsCritical =
    remoteScreens.length > 0 &&
    (quality?.rendererFramesDroppedPercent ?? 0) >=
      THRESHOLDS.rendererFramesDroppedPercent &&
    (quality?.rendererFramesDroppedPerSecond ?? 0) >=
      THRESHOLDS.rendererFramesDroppedPerSecond
  const rendererConsumerChurnCritical =
    remoteScreens.length > 0 &&
    (quality?.rendererConsumerChurnPerSecond ?? 0) >=
      THRESHOLDS.rendererConsumerChurnPerSecond
  const rendererDrawFailed =
    remoteScreens.length > 0 &&
    (quality?.rendererDrawFailuresPerSecond ?? 0) >=
      THRESHOLDS.rendererDrawFailuresPerSecond

  return [
    {
      area: 'screen',
      code: 'screen_publication_stalled',
      active: localStalled,
    },
    {
      area: 'screen',
      code: 'screen_subscription_stalled',
      active: remoteStalled,
    },
    {
      area: 'screen',
      code: 'screen_frames_dropped_critical',
      active: screenDropsCritical,
    },
    {
      area: 'screen',
      code: 'screen_renderer_stalled',
      active: rendererStalled || rendererDrawFailed,
    },
    {
      area: 'screen',
      code: 'screen_renderer_frames_dropped_critical',
      active: rendererDropsCritical,
    },
    {
      area: 'screen',
      code: 'voice_stage_consumer_churn_critical',
      active: rendererConsumerChurnCritical,
    },
    {
      area: 'voice',
      code: 'rtc_audio_concealment_critical',
      active:
        (quality?.concealedAudioPercent ?? 0) >=
          THRESHOLDS.concealedAudioPercent,
    },
    {
      area: 'voice',
      code: 'rtc_packet_loss_critical',
      active:
        (quality?.packetLossPercent ?? 0) >= THRESHOLDS.packetLossPercent,
    },
    {
      area: 'voice',
      code: 'rtc_jitter_critical',
      active: (quality?.jitterMs ?? 0) >= THRESHOLDS.jitterMs,
    },
    {
      area: 'voice',
      code: 'rtc_latency_critical',
      active: (snapshot.transport.pingMs ?? 0) >= THRESHOLDS.pingMs,
    },
  ]
}

function healthContext(snapshot: RtcDebugSnapshot): RtcHealthIncidentContext {
  const quality = snapshot.rates?.quality
  const localScreens = snapshot.screenShares.filter(
    (screen) => screen.isLocal && screen.live,
  )
  const remoteScreens = snapshot.screenShares.filter(
    (screen) => !screen.isLocal && screen.live && screen.subscribed === true,
  )
  const localStalled = localScreens.filter(
    (screen) =>
      (screen.captureVideoPublished === true &&
        screen.captureVideoFrames === 0) ||
      (screen.captureVideoNoFrameCount ?? 0) >= 3 ||
      (screen.sentBitrate != null &&
        screen.sentBitrate <= 1_000 &&
        screen.fps === 0),
  )
  const remoteStalled = remoteScreens.filter(
    (screen) =>
      !screen.trackReady ||
      (screen.receivedBitrate != null &&
        screen.receivedBitrate <= 1_000 &&
        (screen.fps ?? 0) === 0),
  )
  const rendererStalled = remoteScreens.filter(isRendererStalled)
  const rendererScreens = remoteScreens.filter(
    (screen) => screen.rendererFramesReceived != null,
  )
  const native = localScreens.find(
    (screen) => screen.captureBackend === 'native',
  )
  return {
    consecutiveSamples: 0,
    thresholds: THRESHOLDS,
    quality: compactNumbers({
      framesDroppedPercent: quality?.framesDroppedPercent,
      framesDroppedPerSecond: quality?.framesDroppedPerSecond,
      concealedAudioPercent: quality?.concealedAudioPercent,
      packetLossPercent: quality?.packetLossPercent,
      jitterMs: quality?.jitterMs,
      pingMs: snapshot.transport.pingMs,
      rendererFramesDroppedPercent:
        quality?.rendererFramesDroppedPercent,
      rendererFramesDroppedPerSecond:
        quality?.rendererFramesDroppedPerSecond,
      rendererConsumerChurnPerSecond:
        quality?.rendererConsumerChurnPerSecond,
      rendererDrawFailuresPerSecond:
        quality?.rendererDrawFailuresPerSecond,
    }),
    screens: {
      localLive: localScreens.length,
      remoteLive: remoteScreens.length,
      localStalled: localStalled.length,
      remoteStalled: remoteStalled.length,
      rendererStalled: rendererStalled.length,
    },
    renderer: rendererScreens.length > 0
      ? {
          framesReceived: sumRendererMetric(
            rendererScreens,
            'rendererFramesReceived',
          ),
          framesDrawn: sumRendererMetric(
            rendererScreens,
            'rendererFramesDrawn',
          ),
          framesSuperseded: sumRendererMetric(
            rendererScreens,
            'rendererFramesSuperseded',
          ),
          framesDroppedNoConsumer: sumRendererMetric(
            rendererScreens,
            'rendererFramesDroppedNoConsumer',
          ),
          framesDroppedHidden: sumRendererMetric(
            rendererScreens,
            'rendererFramesDroppedHidden',
          ),
          framesDroppedStale: sumRendererMetric(
            rendererScreens,
            'rendererFramesDroppedStale',
          ),
          drawFailures: sumRendererMetric(
            rendererScreens,
            'rendererDrawFailures',
          ),
          canvasAttachCount: sumRendererMetric(
            rendererScreens,
            'rendererCanvasAttachCount',
          ),
          canvasDetachCount: sumRendererMetric(
            rendererScreens,
            'rendererCanvasDetachCount',
          ),
          activeConsumers: sumRendererMetric(
            rendererScreens,
            'rendererActiveConsumers',
          ),
          canvasPixels: sumRendererMetric(
            rendererScreens,
            'rendererCanvasPixels',
          ),
          maxFrameWidth: maximumScreenMetric(
            rendererScreens,
            'rendererFrameWidth',
          ),
          maxFrameHeight: maximumScreenMetric(
            rendererScreens,
            'rendererFrameHeight',
          ),
          maxLastFrameAgeMs: maximumScreenMetric(
            rendererScreens,
            'rendererLastFrameAgeMs',
          ),
          maxLastDrawAgeMs: maximumScreenMetric(
            rendererScreens,
            'rendererLastDrawAgeMs',
          ),
        }
      : undefined,
    nativeCapture: native
      ? compactNumbers({
          videoFrames: native.captureVideoFrames,
          videoNoFrameCount: native.captureVideoNoFrameCount,
          encoderBackpressureTicks:
            native.captureVideoEncoderBackpressureTicks,
          gpuFramesDroppedStale:
            native.captureVideoGpuFramesDroppedStale,
          previewFramesDroppedStale:
            native.captureVideoPreviewFramesDroppedStale,
          gpuSlotTimeouts: native.captureVideoGpuSlotTimeouts,
          previewSlotTimeouts: native.captureVideoPreviewSlotTimeouts,
          rtpFramesEncoded: native.captureRtpFramesEncoded,
          rtpFramesSent: native.captureRtpFramesSent,
          audioFrames: native.captureAudioFrames,
          audioPackets: native.captureAudioPackets,
        })
      : undefined,
  }
}

function isRendererStalled(
  screen: RtcDebugSnapshot['screenShares'][number],
) {
  if (
    (screen.rendererActiveConsumers ?? 0) <= 0 ||
    (screen.rendererFramesReceived ?? 0) <= 0
  ) {
    return false
  }
  const receivingFreshFrames =
    (screen.rendererLastFrameAgeMs ?? Number.POSITIVE_INFINITY) <
    THRESHOLDS.rendererStallMs
  if (!receivingFreshFrames) return false
  if ((screen.rendererFramesDrawn ?? 0) === 0) return true
  return (screen.rendererLastDrawAgeMs ?? 0) >= THRESHOLDS.rendererStallMs
}

function sumRendererMetric(
  screens: RtcDebugSnapshot['screenShares'],
  key: keyof RtcDebugSnapshot['screenShares'][number],
) {
  return screens.reduce((total, screen) => {
    const value = screen[key]
    return total + (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  }, 0)
}

function maximumScreenMetric(
  screens: RtcDebugSnapshot['screenShares'],
  key: keyof RtcDebugSnapshot['screenShares'][number],
) {
  const values = screens.flatMap((screen) => {
    const value = screen[key]
    return typeof value === 'number' && Number.isFinite(value) ? [value] : []
  })
  return values.length > 0 ? Math.max(...values) : undefined
}

function compactNumbers<T extends Record<string, number | undefined>>(
  values: T,
) {
  const compact: { [Key in keyof T]?: number } = {}
  for (const key of Object.keys(values)) {
    const value = values[key]
    if (value !== undefined && Number.isFinite(value)) compact[key] = value
  }
  return compact
}
