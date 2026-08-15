import type {
  DiagnosticLogRecord,
  DiagnosticLogSink,
} from '../native-runtime/diagnostic-log'

export type MediaTimelineFrame = {
  sessionId: string
  generation: number
  trackId: string
  participantIdentity?: string
  frameSequence: number
  nativeCaptureTimestampUs: number
  runtimeEpoch: number
}

export type CorrelatedMediaTimelineFrame = Omit<
  MediaTimelineFrame,
  'participantIdentity'
> & {
  peerAlias?: string
}

export type MediaTimelineVideoStage =
  | 'decoded'
  | 'gpu_submitted'
  | 'native_published'
  | 'electron_imported'
  | 'renderer_handoff'
  | 'renderer_presented'
  | 'renderer_fenced'
  | 'native_release_requested'
  | 'native_released'
  | 'native_release_timeout'
  | 'renderer_recovery'

export type MediaTimelineVideoObservation = {
  anomaly?: string
  durationMs?: number
  metrics?: Record<string, number>
  outcome?: string
}

export type MediaTimelineAudioRtcObservation = {
  sessionId: string
  generation: number
  trackId: string
  runtimeEpoch: number
  jitterBufferDelayMs: number
  jitterBufferTargetDelayMs: number
  jitterBufferEmittedCount: number
  webRtcJitterMs: number
}

type CreateMediaIncidentTimelineOptions = {
  record: DiagnosticLogSink
  now?: () => number
  maximumPeerAliases?: number
  maximumAudioStreams?: number
}

const FRAME_SAMPLE_MODULUS = 120
const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193
const UTF8_ENCODER = new TextEncoder()
const AUDIO_SAMPLE_INTERVAL_MS = 5_000

function positiveBound(value: number | undefined, fallback: number) {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback
}

export function isMediaTimelineFrameSampled(
  frame: Pick<
    MediaTimelineFrame,
    'sessionId' | 'generation' | 'trackId' | 'nativeCaptureTimestampUs'
  >,
) {
  const correlation = [
    frame.sessionId,
    String(frame.generation),
    frame.trackId,
    String(frame.nativeCaptureTimestampUs),
  ].join('\0')
  let hash = FNV_OFFSET_BASIS
  for (const byte of UTF8_ENCODER.encode(correlation)) {
    hash = Math.imul(hash ^ byte, FNV_PRIME) >>> 0
  }
  return hash % FRAME_SAMPLE_MODULUS === 0
}

export function createMediaIncidentTimeline({
  record,
  now = Date.now,
  maximumPeerAliases = 64,
  maximumAudioStreams = 64,
}: CreateMediaIncidentTimelineOptions) {
  const aliases = new Map<string, string>()
  const audioSamples = new Map<string, number>()
  const maximumAliases = positiveBound(maximumPeerAliases, 64)
  const maximumStreams = positiveBound(maximumAudioStreams, 64)
  let nextAlias = 0

  const correlate = (
    frame: MediaTimelineFrame,
  ): CorrelatedMediaTimelineFrame => {
    const participantIdentity = frame.participantIdentity?.trim()
    let peerAlias: string | undefined
    if (participantIdentity) {
      peerAlias = aliases.get(participantIdentity)
      if (!peerAlias) {
        peerAlias = `peer-${++nextAlias}`
        aliases.set(participantIdentity, peerAlias)
        while (aliases.size > maximumAliases) {
          const oldest = aliases.keys().next().value
          if (oldest === undefined) break
          aliases.delete(oldest)
        }
      }
    }
    return {
      sessionId: frame.sessionId,
      generation: frame.generation,
      trackId: frame.trackId,
      frameSequence: frame.frameSequence,
      nativeCaptureTimestampUs: frame.nativeCaptureTimestampUs,
      runtimeEpoch: frame.runtimeEpoch,
      ...(peerAlias ? { peerAlias } : {}),
    }
  }

  const recordVideo = (
    stage: MediaTimelineVideoStage,
    frame: MediaTimelineFrame,
    observation: MediaTimelineVideoObservation = {},
  ) => {
    try {
      if (!observation.anomaly && !isMediaTimelineFrameSampled(frame)) return
      const correlated = correlate(frame)
      const timelineRecord: DiagnosticLogRecord = {
        scope: 'native-video',
        event: 'media_timeline',
        stage,
        ...correlated,
        ...(observation.anomaly ? { reason: observation.anomaly } : {}),
        ...(observation.durationMs === undefined
          ? {}
          : { durationMs: Math.max(0, observation.durationMs) }),
        ...(observation.metrics ? { metrics: observation.metrics } : {}),
        ...(observation.outcome ? { outcome: observation.outcome } : {}),
      }
      record(timelineRecord)
    } catch {
      // Telemetry failures must never change media behavior.
    }
  }

  const recordAudioRtc = (observation: MediaTimelineAudioRtcObservation) => {
    try {
      const streamKey = [
        observation.sessionId,
        observation.generation,
        observation.trackId,
        observation.runtimeEpoch,
      ].join('\0')
      const sampledAt = now()
      const lastSampledAt = audioSamples.get(streamKey)
      if (lastSampledAt !== undefined && sampledAt >= lastSampledAt &&
          sampledAt - lastSampledAt < AUDIO_SAMPLE_INTERVAL_MS) return
      audioSamples.delete(streamKey)
      audioSamples.set(streamKey, sampledAt)
      while (audioSamples.size > maximumStreams) {
        const oldest = audioSamples.keys().next().value
        if (oldest === undefined) break
        audioSamples.delete(oldest)
      }
      record({
        scope: 'desktop-voice',
        event: 'media_timeline',
        stage: 'webrtc_jitter',
        sessionId: observation.sessionId,
        generation: observation.generation,
        trackId: observation.trackId,
        runtimeEpoch: observation.runtimeEpoch,
        metrics: {
          jitterBufferDelayMs: observation.jitterBufferDelayMs,
          jitterBufferTargetDelayMs: observation.jitterBufferTargetDelayMs,
          jitterBufferEmittedCount: observation.jitterBufferEmittedCount,
          webRtcJitterMs: observation.webRtcJitterMs,
        },
      })
    } catch {
      // Telemetry failures must never change media behavior.
    }
  }

  return {
    correlate,
    recordVideo,
    recordAudioRtc,
    snapshot: () => ({
      peerAliases: aliases.size,
      maximumPeerAliases: maximumAliases,
      audioStreams: audioSamples.size,
      maximumAudioStreams: maximumStreams,
    }),
  }
}

export type MediaIncidentTimeline = ReturnType<
  typeof createMediaIncidentTimeline
>
