import type { Room } from 'livekit-client'

import { nativeMediaEngineStatsStore } from '#/features/voice/native-media-engine-stats'
import { getVoicePeerConnectionEntries } from '#/features/voice/voice-ping'

export const RTC_DEBUG_BROWSER_UNAVAILABLE = 'N/A'
export const RTC_DEBUG_HISTORY_LIMIT = 180

type RtcStatsLike = Record<string, unknown> & {
  id: string
  type: string
}

type RtcDebugRoomLike = {
  engine?: unknown
}

type RtcDebugMediaTrack = {
  mediaStreamTrack?: {
    contentHint?: string
    getSettings?: () => MediaTrackSettings
  } | null
}

type RtcDebugPublication = {
  trackSid?: string
  sid?: string
  source?: string
  options?: RtcDebugPublishOptions
}

type RtcDebugPublishOptions = {
  videoCodec?: string
  codec?: string
  simulcast?: boolean
  degradationPreference?: string
  screenShareEncoding?: {
    maxBitrate?: number
    maxFramerate?: number
  }
  videoEncoding?: {
    maxBitrate?: number
    maxFramerate?: number
  }
}

export type RtcDebugStageMediaItem = {
  id: string
  userId: string
  kind: string
  isLocal: boolean
  subscribed?: boolean
  live: boolean
  track?: RtcDebugMediaTrack | null
  publication?: RtcDebugPublication | null
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
  codec?: string
  bitrate?: number
  targetBitrate?: number
  bytesSent?: number
  bytesReceived?: number
  packetsSent?: number
  packetsReceived?: number
  packetsLost?: number
  retransmittedBytesSent?: number
  nackCount?: number
  pliCount?: number
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
  jitterBufferEmittedCount?: number
  jitter?: number
  freezeCount?: number
  totalFreezesDuration?: number
}

export type RtcDebugScreenShareSnapshot = {
  id: string
  ownerUserId: string
  isLocal: boolean
  subscribed?: boolean
  live: boolean
  publicationId?: string
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
}

export type RtcDebugSnapshot = {
  timestamp: number
  transport: RtcDebugTransportSnapshot
  outbound: RtcDebugRtpStreamSnapshot[]
  inbound: RtcDebugRtpStreamSnapshot[]
  screenShares: RtcDebugScreenShareSnapshot[]
  rates?: RtcDebugRates
}

export async function collectVoiceRtcDebugSnapshot(
  room: RtcDebugRoomLike,
  stageMediaItems: readonly RtcDebugStageMediaItem[],
  timestamp = Date.now(),
  statsTimeoutMs = 1_000,
): Promise<RtcDebugSnapshot> {
  const snapshot: RtcDebugSnapshot = {
    timestamp,
    transport: {},
    outbound: [],
    inbound: [],
    screenShares: [],
  }

  const entries = getVoicePeerConnectionEntries(room as Room)

  await Promise.allSettled(entries.map(async (entry) => {
    const report = await promiseWithTimeout(
      entry.pc.getStats(),
      statsTimeoutMs,
      `RTC stats timed out for ${entry.role}`,
    )
    const stats = rtcStatsMap(report)
    const codecs = new Map<string, RtcStatsLike>()
    const candidates = new Map<string, RtcStatsLike>()

    for (const stat of stats.values()) {
      if (stat.type === 'codec') codecs.set(stat.id, stat)
      if (stat.type === 'local-candidate' || stat.type === 'remote-candidate') {
        candidates.set(stat.id, stat)
      }
    }

    const pair = selectedCandidatePair(stats)
    if (pair) {
      mergeTransport(snapshot.transport, pair, candidates)
    }

    for (const stat of stats.values()) {
      if (stat.type === 'outbound-rtp') {
        snapshot.outbound.push(
          rtpStreamSnapshot(entry.role, stat, codecs, 'outbound'),
        )
      }
      if (stat.type === 'inbound-rtp') {
        snapshot.inbound.push(
          rtpStreamSnapshot(entry.role, stat, codecs, 'inbound'),
        )
      }
    }
  }))

  snapshot.screenShares = stageMediaItems
    .filter((item) => item.kind === 'screen')
    .map((item) => screenShareSnapshot(item))

  return snapshot
}

function promiseWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
) {
  return new Promise<T>((resolve, reject) => {
    const timeout = globalThis.setTimeout(
      () => reject(new Error(message)),
      Math.max(1, timeoutMs),
    )
    promise.then(
      (value) => {
        globalThis.clearTimeout(timeout)
        resolve(value)
      },
      (error) => {
        globalThis.clearTimeout(timeout)
        reject(error)
      },
    )
  })
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

  return rates
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
    const value = stat as unknown as RtcStatsLike
    if (value.id && value.type) map.set(value.id, value)
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
  if (transport.pingMs == null && rtt != null) {
    transport.pingMs = Math.round(rtt * 1000)
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
): RtcDebugRtpStreamSnapshot {
  const codec = codecs.get(String(stat.codecId))
  const kind = mediaKind(stat)
  const stream: RtcDebugRtpStreamSnapshot = {
    id: `${role}:${stat.id}`,
    pcRole: role,
    kind,
    ssrc: numberValue(stat.ssrc),
    mid: stringValue(stat.mid),
    codec: formatCodec(codec),
    targetBitrate: numberValue(stat.targetBitrate),
    packetsLost: numberValue(stat.packetsLost),
    nackCount: numberValue(stat.nackCount),
    pliCount: numberValue(stat.pliCount),
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
    jitterBufferEmittedCount: numberValue(stat.jitterBufferEmittedCount),
    jitter: numberValue(stat.jitter),
    freezeCount: numberValue(stat.freezeCount),
    totalFreezesDuration: numberValue(stat.totalFreezesDuration),
  }

  if (direction === 'outbound') {
    stream.bytesSent = numberValue(stat.bytesSent)
    stream.packetsSent = numberValue(stat.packetsSent)
    stream.retransmittedBytesSent = numberValue(stat.retransmittedBytesSent)
  } else {
    stream.bytesReceived = numberValue(stat.bytesReceived)
    stream.packetsReceived = numberValue(stat.packetsReceived)
  }

  return stream
}

function screenShareSnapshot(
  item: RtcDebugStageMediaItem,
): RtcDebugScreenShareSnapshot {
  const publication = item.publication
  const track = item.track?.mediaStreamTrack
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
    publicationId: publication?.trackSid ?? publication?.sid,
    codec: options?.videoCodec ?? options?.codec,
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
      nativeStats?.backend === 'native' ? nativeStats.methods.dxgi : hybridUnavailable,
    hybridGdiBitBltFrames:
      nativeStats?.backend === 'native'
        ? nativeStats.methods.gdi_blt
        : hybridUnavailable,
    hybridGdiPrintWindowFrames: hybridUnavailable,
    hybridGraphicsCaptureFrames:
      nativeStats?.backend === 'native' ? nativeStats.methods.wgc : hybridUnavailable,
    hybridVideohookFrames: hybridUnavailable,
  }
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
  if (typeof value !== 'object' || value == null) return undefined

  const result: Record<string, number> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) return undefined
    result[key] = entry
  }
  return result
}

type RtcDebugRateSnapshotInput = {
  timestamp: number
  transport: {
    bytesSent?: number
    bytesReceived?: number
  }
  outbound: ReadonlyArray<{ id: string; bytesSent?: number }>
  inbound: ReadonlyArray<{ id: string; bytesReceived?: number }>
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

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
