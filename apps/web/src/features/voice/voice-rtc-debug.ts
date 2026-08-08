import { Effect, Option, Schema } from 'effect'
import type { VoiceRtcTelemetrySnapshot } from '@syrnike13/platform'

import { nativeMediaEngineStatsStore } from '#/features/voice/native-media-engine-stats'
import { getVoicePeerConnectionEntries } from '#/features/voice/voice-ping'
import {
  voiceStageMediaStreamTrack,
  type VoiceStageMediaItem,
} from '#/features/voice/voice-context'

export const RTC_DEBUG_BROWSER_UNAVAILABLE = 'N/A'
export const RTC_DEBUG_HISTORY_LIMIT = 180

type RtcStatsLike = Record<string, unknown> & {
  id: string
  type: string
}

const RtcStatsRecordSchema = Schema.Record(Schema.String, Schema.Unknown)

type RtcDebugRoomLike = {
  engine?: unknown
}

export type RtcDebugTransportSnapshot = {
  availableOutgoingBitrate?: number
  availableIncomingBitrate?: number
  pingMs?: number
  localAddress?: string
  remoteAddress?: string
  bytesSent?: number
  bytesReceived?: number
  packetsSent?: number
  packetsReceived?: number
  outboundBitrate?: number
  inboundBitrate?: number
  hostname?: string
  selectedCandidatePairId?: string
}

export type RtcDebugRtpStreamSnapshot = {
  id: string
  pcRole: 'publisher' | 'subscriber'
  kind: 'audio' | 'video'
  ssrc?: number
  mid?: string
  trackIdentifier?: string
  codec?: string
  bitrate?: number
  targetBitrate?: number
  bytesSent?: number
  bytesReceived?: number
  packetsSent?: number
  packetsReceived?: number
  packetsLost?: number
  packetLossPercent?: number
  roundTripTimeMs?: number
  retransmittedPacketsSent?: number
  retransmittedBytesSent?: number
  retransmittedPacketsReceived?: number
  retransmittedBytesReceived?: number
  packetsDiscarded?: number
  nackCount?: number
  firCount?: number
  pliCount?: number
  framesSent?: number
  framesReceived?: number
  framesRendered?: number
  framesEncoded?: number
  framesDecoded?: number
  framesDropped?: number
  framesPerSecond?: number
  frameWidth?: number
  frameHeight?: number
  qualityLimitationReason?: string
  qualityLimitationDurations?: Record<string, number>
  audioLevel?: number
  totalAudioEnergy?: number
  totalSamplesDuration?: number
  totalSamplesReceived?: number
  concealedSamples?: number
  silentConcealedSamples?: number
  concealmentEvents?: number
  jitterBufferDelay?: number
  jitterBufferTargetDelay?: number
  jitterBufferEmittedCount?: number
  jitter?: number
  freezeCount?: number
  totalFreezesDuration?: number
  pauseCount?: number
  totalPauseDuration?: number
  encoderImplementation?: string
  decoderImplementation?: string
}

export type RtcDebugScreenShareSnapshot = {
  id: string
  ownerUserId: string
  isLocal: boolean
  subscribed?: boolean
  live: boolean
  publicationId?: string
  rtpStreamId?: string
  trackReady: boolean
  codec?: string
  maxBitrate?: number
  maxFramerate?: number
  simulcast?: boolean
  degradationPreference?: string
  captureWidth?: number
  captureHeight?: number
  captureFrameRate?: number
  captureBitrate?: number
  displaySurface?: string
  cursor?: string
  logicalSurface?: boolean
  resizeMode?: string
  contentHint?: string
  sentBitrate?: number
  receivedBitrate?: number
  fps?: number
  frameWidth?: number
  frameHeight?: number
  packetsLost?: number
  qualityLimitationReason?: string
  captureBackend?: 'native' | 'chromium'
  captureMethod?: string
  captureVideoPublished?: boolean
  captureVideoFrames?: number
  captureVideoIntervalFrames?: number
  captureVideoLateFrames?: number
  captureVideoNoFrameCount?: number
  captureVideoRepeatedFrameCount?: number
  captureVideoRecoverableLostCount?: number
  captureVideoAvgCaptureUs?: number
  captureVideoAvgReadbackUs?: number
  captureVideoAvgScaleUs?: number
  captureVideoAvgPublishUs?: number
  captureVideoSourceWidth?: number
  captureVideoSourceHeight?: number
  captureVideoContentWidth?: number
  captureVideoContentHeight?: number
  captureThreadMmcss?: boolean
  captureAudioPublished?: boolean
  captureAudioMode?: string
  captureAudioLoopbackMode?: string
  captureAudioTargetProcessId?: number
  captureAudioFrames?: number
  captureAudioPackets?: number
  captureAudioPeakDb?: number
  captureAudioRmsDb?: number
  hybridDxgiFrames: number | typeof RTC_DEBUG_BROWSER_UNAVAILABLE
  hybridGdiBitBltFrames: number | typeof RTC_DEBUG_BROWSER_UNAVAILABLE
  hybridGdiPrintWindowFrames: number | typeof RTC_DEBUG_BROWSER_UNAVAILABLE
  hybridGraphicsCaptureFrames: number | typeof RTC_DEBUG_BROWSER_UNAVAILABLE
  hybridVideohookFrames: typeof RTC_DEBUG_BROWSER_UNAVAILABLE
}

export type RtcDebugRates = {
  transport: {
    outboundBitrate?: number
    inboundBitrate?: number
  }
  outbound: Record<string, number>
  inbound: Record<string, number>
  quality: {
    packetLossPercent?: number
    inboundPacketLossPercent?: number
    outboundPacketLossPercent?: number
    framesDroppedPercent?: number
    framesDroppedPerSecond?: number
    jitterMs?: number
    concealedAudioPercent?: number
  }
}

export type RtcDebugSnapshot = {
  timestamp: number
  source?: 'web' | 'windows_native'
  transport: RtcDebugTransportSnapshot
  outbound: RtcDebugRtpStreamSnapshot[]
  inbound: RtcDebugRtpStreamSnapshot[]
  screenShares: RtcDebugScreenShareSnapshot[]
  rates?: RtcDebugRates
}

export const collectVoiceRtcDebugSnapshotEffect = Effect.fn(
  'voice.collectRtcDebugSnapshot',
)(function*(
  room: RtcDebugRoomLike,
  stageMediaItems: readonly VoiceStageMediaItem[],
  timestamp = Date.now(),
  statsTimeoutMs = 1_000,
) {
  const snapshot: RtcDebugSnapshot = {
    timestamp,
    transport: {},
    outbound: [],
    inbound: [],
    screenShares: [],
    source: 'web',
  }

  const entries = getVoicePeerConnectionEntries(room)

  yield* Effect.all(
    entries.map((entry) =>
      Effect.gen(function*() {
        if (!entry.pc.getStats) return
        const report = yield* promiseWithTimeoutEffect(
          entry.pc.getStats(),
          statsTimeoutMs,
          `RTC stats timed out for ${entry.role}`,
        )
        yield* Effect.sync(() => {
            const stats = rtcStatsMap(report)
            const codecs = new Map<string, RtcStatsLike>()
            const candidates = new Map<string, RtcStatsLike>()
            const remoteInbound = new Map<string, RtcStatsLike>()

            for (const stat of stats.values()) {
              if (stat.type === 'codec') codecs.set(stat.id, stat)
              if (
                stat.type === 'local-candidate' ||
                stat.type === 'remote-candidate'
              ) {
                candidates.set(stat.id, stat)
              }
              if (stat.type === 'remote-inbound-rtp') {
                const localId = stringValue(stat.localId)
                if (localId) remoteInbound.set(localId, stat)
              }
            }

            const pair = selectedCandidatePair(stats)
            if (pair) {
              mergeTransport(snapshot.transport, pair, candidates)
            }

            for (const stat of stats.values()) {
              if (stat.type === 'outbound-rtp') {
                snapshot.outbound.push(
                  rtpStreamSnapshot(
                    entry.role,
                    stat,
                    codecs,
                    'outbound',
                    remoteInbound.get(stat.id),
                  ),
                )
              }
              if (stat.type === 'inbound-rtp') {
                snapshot.inbound.push(
                  rtpStreamSnapshot(entry.role, stat, codecs, 'inbound'),
                )
              }
            }
        })
      }).pipe(Effect.ignore),
    ),
    { concurrency: 'unbounded' },
  )

  snapshot.screenShares = stageMediaItems
    .filter((item) => item.kind === 'screen')
    .map((item) => screenShareSnapshot(item, snapshot.outbound, snapshot.inbound))

  return snapshot
})

export function rtcDebugSnapshotFromTelemetry(
  telemetry: VoiceRtcTelemetrySnapshot,
  stageMediaItems: readonly VoiceStageMediaItem[],
): RtcDebugSnapshot {
  const capture = telemetry.nativeCapture
  if (capture) {
    nativeMediaEngineStatsStore.setNative(
      { ...capture.methods },
      capture.activeMethod,
      undefined,
      {
        width: capture.width,
        height: capture.height,
        fps: capture.fps,
        bitrate: capture.bitrate,
        publishedVideo: capture.publishedVideo,
        publishedAudio: capture.publishedAudio,
        audioFrames: capture.audioFrames,
        audioPackets: capture.audioPackets,
        audioPeakDb: capture.audioPeakDb,
        audioRmsDb: capture.audioRmsDb,
        videoFrames: capture.videoFrames,
        videoIntervalFrames: capture.videoIntervalFrames,
        videoLateFrames: capture.videoLateFrames,
        videoNoFrameCount: capture.videoNoFrameCount,
        videoRepeatedFrameCount: capture.videoRepeatedFrameCount,
        videoRecoverableLostCount: capture.videoRecoverableLostCount,
        videoEncoderBackpressureTicks: capture.videoEncoderBackpressureTicks,
        videoGpuFramesDroppedStale: capture.videoGpuFramesDroppedStale,
        videoPreviewFramesDroppedStale:
          capture.videoPreviewFramesDroppedStale,
        videoAvgCaptureUs: capture.videoAvgCaptureUs,
        videoAvgReadbackUs: capture.videoAvgReadbackUs,
        videoAvgScaleUs: capture.videoAvgScaleUs,
        videoAvgPublishUs: capture.videoAvgPublishUs,
        videoSourceWidth: capture.videoSourceWidth,
        videoSourceHeight: capture.videoSourceHeight,
        videoContentWidth: capture.videoContentWidth,
        videoContentHeight: capture.videoContentHeight,
        captureThreadMmcss: capture.captureThreadMmcss,
      },
    )
  } else if (nativeMediaEngineStatsStore.getState().backend === 'native') {
    nativeMediaEngineStatsStore.reset()
  }

  const snapshot: RtcDebugSnapshot = {
    timestamp: telemetry.timestamp,
    source: 'windows_native',
    transport: { ...telemetry.transport },
    outbound: telemetry.outbound.map((stream) => ({ ...stream })),
    inbound: telemetry.inbound.map((stream) => ({ ...stream })),
    screenShares: [],
  }
  snapshot.screenShares = stageMediaItems
    .filter((item) => item.kind === 'screen')
    .map((item) => screenShareSnapshot(item, snapshot.outbound, snapshot.inbound))
  return snapshot
}

export function collectVoiceRtcDebugSnapshot(
  room: RtcDebugRoomLike,
  stageMediaItems: readonly VoiceStageMediaItem[],
  timestamp = Date.now(),
  statsTimeoutMs = 1_000,
) {
  return Effect.runPromise(
    collectVoiceRtcDebugSnapshotEffect(
      room,
      stageMediaItems,
      timestamp,
      statsTimeoutMs,
    ),
  )
}

function promiseWithTimeoutEffect<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
) {
  return Effect.tryPromise({
    try: () => promise,
    catch: (cause) => cause,
  }).pipe(
    Effect.timeoutOrElse({
      duration: Math.max(1, timeoutMs),
      orElse: () => Effect.fail(new Error(message)),
    }),
  )
}

export function deriveRtcRates(
  previous: RtcDebugRateSnapshotInput,
  current: RtcDebugRateSnapshotInput,
): RtcDebugRates {
  const seconds = (current.timestamp - previous.timestamp) / 1000
  const rates: RtcDebugRates = {
    transport: {},
    outbound: {},
    inbound: {},
    quality: {},
  }
  if (seconds <= 0) return rates

  rates.transport.outboundBitrate = bitrateDelta(
    previous.transport.bytesSent,
    current.transport.bytesSent,
    seconds,
  )
  rates.transport.inboundBitrate = bitrateDelta(
    previous.transport.bytesReceived,
    current.transport.bytesReceived,
    seconds,
  )

  const previousOutbound = byId(previous.outbound)
  for (const stream of current.outbound) {
    const rate = bitrateDelta(
      previousOutbound.get(stream.id)?.bytesSent,
      stream.bytesSent,
      seconds,
    )
    if (rate != null) rates.outbound[stream.id] = rate
  }

  const previousInbound = byId(previous.inbound)
  for (const stream of current.inbound) {
    const rate = bitrateDelta(
      previousInbound.get(stream.id)?.bytesReceived,
      stream.bytesReceived,
      seconds,
    )
    if (rate != null) rates.inbound[stream.id] = rate
  }

  const inboundLoss = inboundPacketLossPercent(previous.inbound, current.inbound)
  const outboundLossValues = current.outbound
    .map((stream) => stream.packetLossPercent)
    .filter((value): value is number => value != null && Number.isFinite(value))
  const outboundLoss =
    outboundLossValues.length > 0 ? Math.max(...outboundLossValues) : undefined
  const frameQuality = droppedFrameQuality(
    previous.inbound,
    current.inbound,
    seconds,
  )
  const jitterValues = current.inbound
    .map((stream) => stream.jitter)
    .filter((value): value is number => value != null && Number.isFinite(value))
  const concealedAudioPercent = audioConcealmentPercent(
    previous.inbound,
    current.inbound,
  )
  setDefined(rates.quality, 'inboundPacketLossPercent', inboundLoss)
  setDefined(rates.quality, 'outboundPacketLossPercent', outboundLoss)
  setDefined(
    rates.quality,
    'packetLossPercent',
    maximumDefined(inboundLoss, outboundLoss),
  )
  setDefined(rates.quality, 'framesDroppedPercent', frameQuality.percent)
  setDefined(rates.quality, 'framesDroppedPerSecond', frameQuality.perSecond)
  setDefined(
    rates.quality,
    'jitterMs',
    jitterValues.length > 0 ? Math.max(...jitterValues) * 1000 : undefined,
  )
  setDefined(rates.quality, 'concealedAudioPercent', concealedAudioPercent)

  return rates
}

export function attachRtcRatesToScreenShares(
  snapshot: RtcDebugSnapshot,
): RtcDebugSnapshot {
  if (!snapshot.rates) return snapshot
  return {
    ...snapshot,
    screenShares: snapshot.screenShares.map((screen) => {
      if (!screen.rtpStreamId) return screen
      return screen.isLocal
        ? {
            ...screen,
            sentBitrate: snapshot.rates?.outbound[screen.rtpStreamId],
          }
        : {
            ...screen,
            receivedBitrate: snapshot.rates?.inbound[screen.rtpStreamId],
          }
    }),
  }
}

export function appendRtcDebugSample<T extends { timestamp: number }>(
  history: readonly T[],
  sample: T,
) {
  return [...history, sample].slice(-RTC_DEBUG_HISTORY_LIMIT)
}

export function formatRtcBitrate(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return '—'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} Mbps`
  return `${(value / 1000).toFixed(2)} Kbps`
}

export function formatRtcBytes(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return '—'
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(2)} KB`
  return `${value} bytes`
}

export function formatRtcMs(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${Math.round(value)} ms`
}

export function formatRtcPercent(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`
}

export function formatRtcFps(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${Number(value).toFixed(2)}`
}

export function formatRtcInteger(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return '—'
  return String(Math.round(value))
}

export function formatRtcValue(value: unknown) {
  if (value == null || value === '') return '—'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}

function rtcStatsMap(report: RTCStatsReport) {
  const map = new Map<string, RtcStatsLike>()
  report.forEach((stat) => {
    const decoded = Schema.decodeUnknownOption(RtcStatsRecordSchema)(stat)
    if (Option.isNone(decoded)) return
    const id = stringValue(decoded.value.id)
    const type = stringValue(decoded.value.type)
    if (id && type) map.set(id, { ...decoded.value, id, type })
  })
  return map
}

function selectedCandidatePair(stats: Map<string, RtcStatsLike>) {
  let succeeded: RtcStatsLike | null = null
  for (const stat of stats.values()) {
    if (stat.type !== 'candidate-pair') continue
    if (stat.nominated === true) return stat
    if (!succeeded && stat.state === 'succeeded') succeeded = stat
  }
  return succeeded
}

function mergeTransport(
  transport: RtcDebugTransportSnapshot,
  pair: RtcStatsLike,
  candidates: Map<string, RtcStatsLike>,
) {
  transport.selectedCandidatePairId ??= pair.id
  transport.availableOutgoingBitrate ??= numberValue(
    pair.availableOutgoingBitrate,
  )
  transport.availableIncomingBitrate ??= numberValue(
    pair.availableIncomingBitrate,
  )
  transport.bytesSent = addOptional(transport.bytesSent, numberValue(pair.bytesSent))
  transport.bytesReceived = addOptional(
    transport.bytesReceived,
    numberValue(pair.bytesReceived),
  )
  transport.packetsSent = addOptional(
    transport.packetsSent,
    numberValue(pair.packetsSent),
  )
  transport.packetsReceived = addOptional(
    transport.packetsReceived,
    numberValue(pair.packetsReceived),
  )

  const rtt = numberValue(pair.currentRoundTripTime)
  if (rtt != null) {
    transport.pingMs = Math.max(
      transport.pingMs ?? 0,
      Math.round(rtt * 1000),
    )
  }

  const local = candidates.get(String(pair.localCandidateId))
  const remote = candidates.get(String(pair.remoteCandidateId))
  transport.localAddress ??= formatCandidateAddress(local)
  transport.remoteAddress ??= formatCandidateAddress(remote)
}

function rtpStreamSnapshot(
  role: 'publisher' | 'subscriber',
  stat: RtcStatsLike,
  codecs: Map<string, RtcStatsLike>,
  direction: 'outbound' | 'inbound',
  remoteInbound?: RtcStatsLike,
): RtcDebugRtpStreamSnapshot {
  const codec = codecs.get(String(stat.codecId))
  const kind = mediaKind(stat)
  const remotePacketLossFraction = numberValue(remoteInbound?.fractionLost)
  const remoteRoundTripTime = numberValue(remoteInbound?.roundTripTime)
  const stream: RtcDebugRtpStreamSnapshot = {
    id: `${role}:${stat.id}`,
    pcRole: role,
    kind,
    ssrc: numberValue(stat.ssrc),
    mid: stringValue(stat.mid),
    trackIdentifier: stringValue(stat.trackIdentifier),
    codec: formatCodec(codec),
    targetBitrate: numberValue(stat.targetBitrate),
    packetsLost: numberValue(stat.packetsLost),
    packetLossPercent:
      remotePacketLossFraction == null
        ? undefined
        : Math.max(0, remotePacketLossFraction * 100),
    roundTripTimeMs:
      remoteRoundTripTime == null
        ? undefined
        : Math.max(0, remoteRoundTripTime * 1000),
    retransmittedPacketsSent: numberValue(stat.retransmittedPacketsSent),
    nackCount: numberValue(stat.nackCount),
    firCount: numberValue(stat.firCount),
    pliCount: numberValue(stat.pliCount),
    framesSent: numberValue(stat.framesSent),
    framesReceived: numberValue(stat.framesReceived),
    framesRendered: numberValue(stat.framesRendered),
    framesEncoded: numberValue(stat.framesEncoded),
    framesDecoded: numberValue(stat.framesDecoded),
    framesDropped: numberValue(stat.framesDropped),
    framesPerSecond: numberValue(stat.framesPerSecond),
    frameWidth: numberValue(stat.frameWidth),
    frameHeight: numberValue(stat.frameHeight),
    qualityLimitationReason: stringValue(stat.qualityLimitationReason),
    qualityLimitationDurations: numberRecord(stat.qualityLimitationDurations),
    audioLevel: numberValue(stat.audioLevel),
    totalAudioEnergy: numberValue(stat.totalAudioEnergy),
    totalSamplesDuration: numberValue(stat.totalSamplesDuration),
    totalSamplesReceived: numberValue(stat.totalSamplesReceived),
    concealedSamples: numberValue(stat.concealedSamples),
    silentConcealedSamples: numberValue(stat.silentConcealedSamples),
    concealmentEvents: numberValue(stat.concealmentEvents),
    jitterBufferDelay: numberValue(stat.jitterBufferDelay),
    jitterBufferTargetDelay: numberValue(stat.jitterBufferTargetDelay),
    jitterBufferEmittedCount: numberValue(stat.jitterBufferEmittedCount),
    jitter: numberValue(stat.jitter),
    freezeCount: numberValue(stat.freezeCount),
    totalFreezesDuration: numberValue(stat.totalFreezesDuration),
    pauseCount: numberValue(stat.pauseCount),
    totalPauseDuration: numberValue(stat.totalPauseDuration),
    encoderImplementation: stringValue(stat.encoderImplementation),
    decoderImplementation: stringValue(stat.decoderImplementation),
  }

  if (direction === 'outbound') {
    stream.bytesSent = numberValue(stat.bytesSent)
    stream.packetsSent = numberValue(stat.packetsSent)
    stream.retransmittedBytesSent = numberValue(stat.retransmittedBytesSent)
  } else {
    stream.bytesReceived = numberValue(stat.bytesReceived)
    stream.packetsReceived = numberValue(stat.packetsReceived)
    stream.retransmittedPacketsReceived = numberValue(
      stat.retransmittedPacketsReceived,
    )
    stream.retransmittedBytesReceived = numberValue(
      stat.retransmittedBytesReceived,
    )
    stream.packetsDiscarded = numberValue(stat.packetsDiscarded)
  }

  return stream
}

function screenShareSnapshot(
  item: VoiceStageMediaItem,
  outbound: readonly RtcDebugRtpStreamSnapshot[],
  inbound: readonly RtcDebugRtpStreamSnapshot[],
): RtcDebugScreenShareSnapshot {
  const publication = item.publication
  const track = voiceStageMediaStreamTrack(item.track)
  const rtpStream = screenShareRtpStream(item, outbound, inbound)
  const settings = track?.getSettings?.()
  const browserSettings = settings as
    | (MediaTrackSettings & {
        cursor?: string
        logicalSurface?: boolean
        resizeMode?: string
      })
    | undefined
  const options = publication?.options
  const encoding = options?.screenShareEncoding ?? options?.videoEncoding

  const nativeStats = item.isLocal ? nativeMediaEngineStatsStore.getState() : null
  const hybridUnavailable = RTC_DEBUG_BROWSER_UNAVAILABLE

  return {
    id: item.id,
    ownerUserId: item.userId,
    isLocal: item.isLocal,
    subscribed: item.subscribed,
    live: item.live,
    publicationId: publication?.trackSid,
    rtpStreamId: rtpStream?.id,
    trackReady: Boolean(item.track),
    codec: options?.videoCodec,
    maxBitrate: encoding?.maxBitrate,
    maxFramerate: encoding?.maxFramerate,
    simulcast: options?.simulcast,
    degradationPreference: options?.degradationPreference,
    captureWidth:
      nativeStats?.backend === 'native' ? nativeStats.width : browserSettings?.width,
    captureHeight:
      nativeStats?.backend === 'native'
        ? nativeStats.height
        : browserSettings?.height,
    captureFrameRate:
      nativeStats?.backend === 'native' ? nativeStats.fps : browserSettings?.frameRate,
    displaySurface: stringValue(browserSettings?.displaySurface),
    cursor: stringValue(browserSettings?.cursor),
    logicalSurface: browserSettings?.logicalSurface,
    resizeMode: stringValue(browserSettings?.resizeMode),
    contentHint: track?.contentHint,
    fps: rtpStream?.framesPerSecond,
    frameWidth: rtpStream?.frameWidth,
    frameHeight: rtpStream?.frameHeight,
    packetsLost: rtpStream?.packetsLost,
    qualityLimitationReason: rtpStream?.qualityLimitationReason,
    captureBackend: nativeStats?.backend,
    captureMethod:
      nativeStats?.backend === 'native'
        ? nativeStats.activeMethod
        : undefined,
    captureVideoPublished:
      nativeStats?.backend === 'native'
        ? nativeStats.publishedVideo
        : undefined,
    captureVideoFrames:
      nativeStats?.backend === 'native' ? nativeStats.videoFrames : undefined,
    captureVideoIntervalFrames:
      nativeStats?.backend === 'native'
        ? nativeStats.videoIntervalFrames
        : undefined,
    captureVideoLateFrames:
      nativeStats?.backend === 'native'
        ? nativeStats.videoLateFrames
        : undefined,
    captureVideoNoFrameCount:
      nativeStats?.backend === 'native'
        ? nativeStats.videoNoFrameCount
        : undefined,
    captureVideoRepeatedFrameCount:
      nativeStats?.backend === 'native'
        ? nativeStats.videoRepeatedFrameCount
        : undefined,
    captureVideoRecoverableLostCount:
      nativeStats?.backend === 'native'
        ? nativeStats.videoRecoverableLostCount
        : undefined,
    captureVideoAvgCaptureUs:
      nativeStats?.backend === 'native'
        ? nativeStats.videoAvgCaptureUs
        : undefined,
    captureVideoAvgReadbackUs:
      nativeStats?.backend === 'native'
        ? nativeStats.videoAvgReadbackUs
        : undefined,
    captureVideoAvgScaleUs:
      nativeStats?.backend === 'native'
        ? nativeStats.videoAvgScaleUs
        : undefined,
    captureVideoAvgPublishUs:
      nativeStats?.backend === 'native'
        ? nativeStats.videoAvgPublishUs
        : undefined,
    captureVideoSourceWidth:
      nativeStats?.backend === 'native'
        ? nativeStats.videoSourceWidth
        : undefined,
    captureVideoSourceHeight:
      nativeStats?.backend === 'native'
        ? nativeStats.videoSourceHeight
        : undefined,
    captureVideoContentWidth:
      nativeStats?.backend === 'native'
        ? nativeStats.videoContentWidth
        : undefined,
    captureVideoContentHeight:
      nativeStats?.backend === 'native'
        ? nativeStats.videoContentHeight
        : undefined,
    captureThreadMmcss:
      nativeStats?.backend === 'native'
        ? nativeStats.captureThreadMmcss
        : undefined,
    captureAudioPublished:
      nativeStats?.backend === 'native'
        ? nativeStats.publishedAudio
        : undefined,
    captureAudioMode:
      nativeStats?.backend === 'native' ? nativeStats.audioMode : undefined,
    captureAudioLoopbackMode:
      nativeStats?.backend === 'native'
        ? nativeStats.audioLoopbackMode
        : undefined,
    captureAudioTargetProcessId:
      nativeStats?.backend === 'native'
        ? nativeStats.audioTargetProcessId
        : undefined,
    captureAudioFrames:
      nativeStats?.backend === 'native' ? nativeStats.audioFrames : undefined,
    captureAudioPackets:
      nativeStats?.backend === 'native' ? nativeStats.audioPackets : undefined,
    captureAudioPeakDb:
      nativeStats?.backend === 'native' ? nativeStats.audioPeakDb : undefined,
    captureAudioRmsDb:
      nativeStats?.backend === 'native' ? nativeStats.audioRmsDb : undefined,
    captureBitrate:
      nativeStats?.backend === 'native' ? nativeStats.bitrate : undefined,
    hybridDxgiFrames:
      nativeStats?.backend === 'native' ? nativeStats.methods.dxgi_gpu : hybridUnavailable,
    hybridGdiBitBltFrames: hybridUnavailable,
    hybridGdiPrintWindowFrames: hybridUnavailable,
    hybridGraphicsCaptureFrames:
      nativeStats?.backend === 'native' ? nativeStats.methods.wgc_gpu : hybridUnavailable,
    hybridVideohookFrames: hybridUnavailable,
  }
}

function screenShareRtpStream(
  item: VoiceStageMediaItem,
  outbound: readonly RtcDebugRtpStreamSnapshot[],
  inbound: readonly RtcDebugRtpStreamSnapshot[],
) {
  const streams = (item.isLocal ? outbound : inbound).filter(
    (stream) =>
      stream.kind === 'video' &&
      stream.pcRole === (item.isLocal ? 'publisher' : 'subscriber'),
  )
  const trackId = voiceStageMediaStreamTrack(item.track)?.id
  if (trackId) {
    const matching = streams.find(
      (stream) => stream.trackIdentifier === trackId,
    )
    if (matching) return matching
  }
  return streams.length === 1 ? streams[0] : undefined
}

function mediaKind(stat: RtcStatsLike): 'audio' | 'video' {
  const value = stat.kind ?? stat.mediaType
  return value === 'audio' ? 'audio' : 'video'
}

function formatCodec(codec?: RtcStatsLike) {
  if (!codec) return undefined
  const mimeType = stringValue(codec.mimeType)
  const payloadType = numberValue(codec.payloadType)
  const name = mimeType?.split('/').pop() ?? mimeType
  if (!name) return undefined
  return payloadType == null ? name : `${name} (${payloadType})`
}

function formatCandidateAddress(candidate?: RtcStatsLike) {
  if (!candidate) return undefined
  const address =
    stringValue(candidate.address) ??
    stringValue(candidate.ip) ??
    stringValue(candidate.hostname)
  if (!address) return undefined
  const port = numberValue(candidate.port)
  const protocol = stringValue(candidate.protocol)
  return `${address}${port == null ? '' : `:${port}`}${
    protocol ? `/${protocol}` : ''
  }`
}

function addOptional(current: number | undefined, next: number | undefined) {
  if (next == null) return current
  return (current ?? 0) + next
}

function numberRecord(value: unknown): Record<string, number> | undefined {
  const decoded = Schema.decodeUnknownOption(
    Schema.Record(Schema.String, Schema.Finite),
  )(value)
  return Option.isSome(decoded) ? { ...decoded.value } : undefined
}

type RtcDebugRateSnapshotInput = {
  timestamp: number
  transport: {
    bytesSent?: number
    bytesReceived?: number
  }
  outbound: ReadonlyArray<{
    id: string
    bytesSent?: number
    packetLossPercent?: number
  }>
  inbound: ReadonlyArray<{
    id: string
    bytesReceived?: number
    packetsReceived?: number
    packetsLost?: number
    framesDecoded?: number
    framesDropped?: number
    totalSamplesReceived?: number
    concealedSamples?: number
    jitter?: number
  }>
}

export type RtcConnectionQuality = 'good' | 'fair' | 'poor' | 'unknown'

export function rtcConnectionQuality(
  snapshot: RtcDebugSnapshot | null,
): RtcConnectionQuality {
  if (!snapshot) return 'unknown'
  const ping = snapshot.transport.pingMs
  const quality = snapshot.rates?.quality
  const values = [
    ping,
    quality?.packetLossPercent,
    quality?.jitterMs,
    quality?.framesDroppedPercent,
    quality?.concealedAudioPercent,
  ]
  if (values.every((value) => value == null)) return 'unknown'
  if (
    (ping ?? 0) >= 250 ||
    (quality?.packetLossPercent ?? 0) >= 5 ||
    (quality?.jitterMs ?? 0) >= 60 ||
    (quality?.framesDroppedPercent ?? 0) >= 10 ||
    (quality?.concealedAudioPercent ?? 0) >= 10
  ) {
    return 'poor'
  }
  if (
    (ping ?? 0) >= 120 ||
    (quality?.packetLossPercent ?? 0) >= 2 ||
    (quality?.jitterMs ?? 0) >= 30 ||
    (quality?.framesDroppedPercent ?? 0) >= 3 ||
    (quality?.concealedAudioPercent ?? 0) >= 3
  ) {
    return 'fair'
  }
  return 'good'
}

function byId<T extends { id: string }>(streams: readonly T[]) {
  return new Map(streams.map((stream) => [stream.id, stream]))
}

function bitrateDelta(
  previous: number | undefined,
  current: number | undefined,
  seconds: number,
) {
  if (previous == null || current == null) return undefined
  const delta = current - previous
  if (delta < 0) return undefined
  return Math.round((delta * 8) / seconds)
}

function inboundPacketLossPercent(
  previous: RtcDebugRateSnapshotInput['inbound'],
  current: RtcDebugRateSnapshotInput['inbound'],
) {
  const previousById = byId(previous)
  let receivedDelta = 0
  let lostDelta = 0
  let hasCounters = false

  for (const stream of current) {
    const prior = previousById.get(stream.id)
    const received = counterDelta(prior?.packetsReceived, stream.packetsReceived)
    const lost = counterDelta(prior?.packetsLost, stream.packetsLost)
    if (received == null && lost == null) continue
    hasCounters = true
    receivedDelta += received ?? 0
    lostDelta += lost ?? 0
  }

  const total = receivedDelta + lostDelta
  return hasCounters && total > 0 ? (lostDelta / total) * 100 : undefined
}

function droppedFrameQuality(
  previous: RtcDebugRateSnapshotInput['inbound'],
  current: RtcDebugRateSnapshotInput['inbound'],
  seconds: number,
) {
  const previousById = byId(previous)
  let decodedDelta = 0
  let droppedDelta = 0
  let hasCounters = false

  for (const stream of current) {
    if (stream.framesDecoded == null && stream.framesDropped == null) continue
    const prior = previousById.get(stream.id)
    const decoded = counterDelta(prior?.framesDecoded, stream.framesDecoded)
    const dropped = counterDelta(prior?.framesDropped, stream.framesDropped)
    if (decoded == null && dropped == null) continue
    hasCounters = true
    decodedDelta += decoded ?? 0
    droppedDelta += dropped ?? 0
  }

  const total = decodedDelta + droppedDelta
  return {
    percent:
      hasCounters && total > 0 ? (droppedDelta / total) * 100 : undefined,
    perSecond:
      hasCounters && seconds > 0 ? droppedDelta / seconds : undefined,
  }
}

function audioConcealmentPercent(
  previous: RtcDebugRateSnapshotInput['inbound'],
  current: RtcDebugRateSnapshotInput['inbound'],
) {
  const previousById = byId(previous)
  let samplesDelta = 0
  let concealedDelta = 0
  let hasCounters = false

  for (const stream of current) {
    if (
      stream.totalSamplesReceived == null &&
      stream.concealedSamples == null
    ) {
      continue
    }
    const prior = previousById.get(stream.id)
    const samples = counterDelta(
      prior?.totalSamplesReceived,
      stream.totalSamplesReceived,
    )
    const concealed = counterDelta(
      prior?.concealedSamples,
      stream.concealedSamples,
    )
    if (samples == null && concealed == null) continue
    hasCounters = true
    samplesDelta += samples ?? 0
    concealedDelta += concealed ?? 0
  }

  return hasCounters && samplesDelta > 0
    ? (concealedDelta / samplesDelta) * 100
    : undefined
}

function counterDelta(previous?: number, current?: number) {
  if (previous == null || current == null) return undefined
  const delta = current - previous
  return delta >= 0 ? delta : undefined
}

function maximumDefined(...values: Array<number | undefined>) {
  const defined = values.filter(
    (value): value is number => value != null && Number.isFinite(value),
  )
  return defined.length > 0 ? Math.max(...defined) : undefined
}

function setDefined<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
) {
  if (value != null) target[key] = value
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
