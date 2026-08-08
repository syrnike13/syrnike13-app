import { Option, Schema } from 'effect'

const finiteNonNegative = Schema.Finite.check(
  Schema.isGreaterThanOrEqualTo(0),
)

const optionalFinite = Schema.optional(Schema.Finite)
const optionalNonNegative = Schema.optional(finiteNonNegative)

export const VoiceRtcTransportTelemetrySchema = Schema.Struct({
  availableOutgoingBitrate: optionalNonNegative,
  availableIncomingBitrate: optionalNonNegative,
  pingMs: optionalNonNegative,
  localAddress: Schema.optional(Schema.String),
  remoteAddress: Schema.optional(Schema.String),
  bytesSent: optionalNonNegative,
  bytesReceived: optionalNonNegative,
  packetsSent: optionalNonNegative,
  packetsReceived: optionalNonNegative,
  selectedCandidatePairId: Schema.optional(Schema.String),
})

export const VoiceRtcStreamTelemetrySchema = Schema.Struct({
  id: Schema.String,
  pcRole: Schema.Literals(['publisher', 'subscriber']),
  kind: Schema.Literals(['audio', 'video']),
  ssrc: optionalNonNegative,
  mid: Schema.optional(Schema.String),
  trackIdentifier: Schema.optional(Schema.String),
  codec: Schema.optional(Schema.String),
  targetBitrate: optionalNonNegative,
  bytesSent: optionalNonNegative,
  bytesReceived: optionalNonNegative,
  packetsSent: optionalNonNegative,
  packetsReceived: optionalNonNegative,
  packetsLost: optionalFinite,
  packetLossPercent: optionalNonNegative,
  roundTripTimeMs: optionalNonNegative,
  retransmittedPacketsSent: optionalNonNegative,
  retransmittedBytesSent: optionalNonNegative,
  retransmittedPacketsReceived: optionalNonNegative,
  retransmittedBytesReceived: optionalNonNegative,
  packetsDiscarded: optionalNonNegative,
  nackCount: optionalNonNegative,
  firCount: optionalNonNegative,
  pliCount: optionalNonNegative,
  framesSent: optionalNonNegative,
  framesReceived: optionalNonNegative,
  framesRendered: optionalNonNegative,
  framesEncoded: optionalNonNegative,
  framesDecoded: optionalNonNegative,
  framesDropped: optionalNonNegative,
  framesPerSecond: optionalNonNegative,
  frameWidth: optionalNonNegative,
  frameHeight: optionalNonNegative,
  qualityLimitationReason: Schema.optional(Schema.String),
  audioLevel: optionalFinite,
  totalAudioEnergy: optionalNonNegative,
  totalSamplesDuration: optionalNonNegative,
  totalSamplesReceived: optionalNonNegative,
  concealedSamples: optionalNonNegative,
  silentConcealedSamples: optionalNonNegative,
  concealmentEvents: optionalNonNegative,
  jitterBufferDelay: optionalNonNegative,
  jitterBufferTargetDelay: optionalNonNegative,
  jitterBufferEmittedCount: optionalNonNegative,
  jitter: optionalNonNegative,
  freezeCount: optionalNonNegative,
  totalFreezesDuration: optionalNonNegative,
  pauseCount: optionalNonNegative,
  totalPauseDuration: optionalNonNegative,
  encoderImplementation: Schema.optional(Schema.String),
  decoderImplementation: Schema.optional(Schema.String),
})

export const VoiceNativeCaptureTelemetrySchema = Schema.Struct({
  methods: Schema.Struct({
    wgc_gpu: finiteNonNegative,
    dxgi_gpu: finiteNonNegative,
  }),
  activeMethod: Schema.optional(Schema.Literals(['wgc_gpu', 'dxgi_gpu'])),
  width: optionalNonNegative,
  height: optionalNonNegative,
  fps: optionalNonNegative,
  bitrate: optionalNonNegative,
  publishedVideo: Schema.optional(Schema.Boolean),
  publishedAudio: Schema.optional(Schema.Boolean),
  audioFrames: optionalNonNegative,
  audioPackets: optionalNonNegative,
  audioPeakDb: optionalFinite,
  audioRmsDb: optionalFinite,
  videoFrames: optionalNonNegative,
  videoIntervalFrames: optionalNonNegative,
  videoLateFrames: optionalNonNegative,
  videoNoFrameCount: optionalNonNegative,
  videoRepeatedFrameCount: optionalNonNegative,
  videoRecoverableLostCount: optionalNonNegative,
  videoEncoderBackpressureTicks: optionalNonNegative,
  videoGpuFramesDroppedStale: optionalNonNegative,
  videoPreviewFramesDroppedStale: optionalNonNegative,
  videoAvgCaptureUs: optionalNonNegative,
  videoAvgReadbackUs: optionalNonNegative,
  videoAvgScaleUs: optionalNonNegative,
  videoAvgPublishUs: optionalNonNegative,
  videoSourceWidth: optionalNonNegative,
  videoSourceHeight: optionalNonNegative,
  videoContentWidth: optionalNonNegative,
  videoContentHeight: optionalNonNegative,
  captureThreadMmcss: Schema.optional(Schema.Boolean),
})

export const VoiceRtcTelemetrySnapshotSchema = Schema.Struct({
  timestamp: finiteNonNegative,
  transport: VoiceRtcTransportTelemetrySchema,
  outbound: Schema.Array(VoiceRtcStreamTelemetrySchema),
  inbound: Schema.Array(VoiceRtcStreamTelemetrySchema),
  nativeCapture: Schema.optional(VoiceNativeCaptureTelemetrySchema),
})

export type VoiceRtcTransportTelemetry =
  typeof VoiceRtcTransportTelemetrySchema.Type
export type VoiceRtcStreamTelemetry = typeof VoiceRtcStreamTelemetrySchema.Type
export type VoiceNativeCaptureTelemetry =
  typeof VoiceNativeCaptureTelemetrySchema.Type
export type VoiceRtcTelemetrySnapshot =
  typeof VoiceRtcTelemetrySnapshotSchema.Type

export function isVoiceRtcTelemetrySnapshot(
  value: unknown,
): value is VoiceRtcTelemetrySnapshot {
  return Option.isSome(
    Schema.decodeUnknownOption(VoiceRtcTelemetrySnapshotSchema)(value),
  )
}
