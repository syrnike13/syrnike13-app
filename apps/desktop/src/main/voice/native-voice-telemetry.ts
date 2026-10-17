import type {
  VoiceRtcStreamTelemetry,
  VoiceRtcTelemetrySnapshot,
} from '@syrnike13/platform'
import type { MediaLifecycleDiagnosticEvent } from '../media-runtime/contract'

type Metrics = ReadonlyMap<string, number>
type Sample = { receivedAt: number; timestampMs: number; metrics: Metrics }

/** A diagnostic family older than this no longer describes the connection. */
export const NATIVE_VOICE_TELEMETRY_STALE_MS = 10_000

const TRACKED_CODES = new Set([
  'transport_network_metrics',
  'remote_microphone_network_metrics',
  'remote_screen_audio_network_metrics',
  'remote_video_network_metrics',
])

function metricsOf(event: MediaLifecycleDiagnosticEvent): Metrics {
  return new Map(event.metrics.map((metric) => [metric.name, metric.value]))
}

/** Native counters use -1 for "not reported". */
function nonNegative(metrics: Metrics, name: string): number | undefined {
  const value = metrics.get(name)
  return value != null && Number.isFinite(value) && value >= 0 ? value : undefined
}

function finite(metrics: Metrics, name: string): number | undefined {
  const value = metrics.get(name)
  return value != null && Number.isFinite(value) ? value : undefined
}

function defined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key]
  }
  return value
}

function round(value: number | undefined, digits = 0) {
  if (value == null) return undefined
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function inboundAudioStream(
  id: string,
  metrics: Metrics,
): VoiceRtcStreamTelemetry | null {
  if ((nonNegative(metrics, 'streams') ?? 0) <= 0) return null
  const jitterMs = nonNegative(metrics, 'jitter_max_ms')
  return defined({
    id,
    pcRole: 'subscriber',
    kind: 'audio',
    packetsReceived: nonNegative(metrics, 'packets_received'),
    packetsLost: finite(metrics, 'packets_lost'),
    bytesReceived: nonNegative(metrics, 'bytes_received'),
    totalSamplesReceived: nonNegative(metrics, 'total_samples_received'),
    concealedSamples: nonNegative(metrics, 'concealed_samples'),
    silentConcealedSamples: nonNegative(metrics, 'silent_concealed_samples'),
    concealmentEvents: nonNegative(metrics, 'concealment_events'),
    jitterBufferDelay: nonNegative(metrics, 'jitter_buffer_delay'),
    jitterBufferEmittedCount: nonNegative(metrics, 'jitter_buffer_emitted_count'),
    jitter: jitterMs != null ? jitterMs / 1000 : undefined,
  } satisfies VoiceRtcStreamTelemetry)
}

function inboundVideoStream(metrics: Metrics): VoiceRtcStreamTelemetry | null {
  if ((nonNegative(metrics, 'streams') ?? 0) <= 0) return null
  return defined({
    id: 'native:inbound:video',
    pcRole: 'subscriber',
    kind: 'video',
    packetsReceived: nonNegative(metrics, 'packets_received'),
    packetsLost: finite(metrics, 'packets_lost'),
    framesDecoded: nonNegative(metrics, 'frames_decoded'),
    framesDropped: nonNegative(metrics, 'frames_dropped'),
    freezeCount: nonNegative(metrics, 'freeze_count'),
    totalFreezesDuration: nonNegative(metrics, 'total_freezes_duration'),
    pauseCount: nonNegative(metrics, 'pause_count'),
    totalPauseDuration: nonNegative(metrics, 'total_pause_duration'),
    jitterBufferDelay: nonNegative(metrics, 'jitter_buffer_delay'),
    jitterBufferEmittedCount: nonNegative(metrics, 'jitter_buffer_emitted_count'),
  } satisfies VoiceRtcStreamTelemetry)
}

/**
 * Projects the native engine's periodic network diagnostics into the renderer
 * telemetry contract (ping, throughput, loss, jitter). The engine emits
 * transport metrics every second and per-source inbound metrics every 2 s.
 */
export class NativeVoiceTelemetry {
  private readonly samples = new Map<string, Sample>()
  private lastTransportSampledAt: number | undefined

  constructor(private readonly now: () => number = Date.now) {}

  observe(event: MediaLifecycleDiagnosticEvent): void {
    if (!TRACKED_CODES.has(event.code)) return
    const metrics = metricsOf(event)
    if (event.code === 'transport_network_metrics') {
      // The engine re-emits its latest getStats result every second. Repeating
      // an old result with a new timestamp would read as zero throughput.
      const sampledAt = metrics.get('sampled_at_ms')
      if (sampledAt != null && sampledAt === this.lastTransportSampledAt) {
        const previous = this.samples.get(event.code)
        if (previous) {
          this.samples.set(event.code, { ...previous, receivedAt: this.now() })
          return
        }
      }
      this.lastTransportSampledAt = sampledAt
    }
    this.samples.set(event.code, {
      receivedAt: this.now(),
      timestampMs: event.timestampMs,
      metrics,
    })
  }

  reset(): void {
    this.samples.clear()
    this.lastTransportSampledAt = undefined
  }

  snapshot(): VoiceRtcTelemetrySnapshot | null {
    const now = this.now()
    const fresh = (code: string) => {
      const sample = this.samples.get(code)
      return sample && now - sample.receivedAt <= NATIVE_VOICE_TELEMETRY_STALE_MS
        ? sample
        : undefined
    }
    const transport = fresh('transport_network_metrics')
    const microphone = fresh('remote_microphone_network_metrics')
    const screenAudio = fresh('remote_screen_audio_network_metrics')
    const video = fresh('remote_video_network_metrics')
    if (!transport && !microphone && !screenAudio && !video) return null

    const outbound: VoiceRtcStreamTelemetry[] = []
    if (transport) {
      const metrics = transport.metrics
      const packetsSent = nonNegative(metrics, 'audio_packets_sent')
      if (packetsSent != null && packetsSent > 0) {
        const fractionLost = nonNegative(metrics, 'audio_remote_fraction_lost')
        const jitterMs = nonNegative(metrics, 'audio_remote_jitter_ms')
        outbound.push(defined({
          id: 'native:outbound:audio',
          pcRole: 'publisher',
          kind: 'audio',
          packetsSent,
          bytesSent: nonNegative(metrics, 'audio_bytes_sent'),
          packetsLost: nonNegative(metrics, 'audio_remote_packets_lost'),
          packetLossPercent: fractionLost != null ? round(fractionLost * 100, 2) : undefined,
          roundTripTimeMs: round(nonNegative(metrics, 'audio_remote_rtt_ms')),
          jitter: jitterMs != null ? jitterMs / 1000 : undefined,
        } satisfies VoiceRtcStreamTelemetry))
      }
    }

    const inbound = [
      microphone && inboundAudioStream('native:inbound:microphone', microphone.metrics),
      screenAudio && inboundAudioStream('native:inbound:screen_audio', screenAudio.metrics),
      video && inboundVideoStream(video.metrics),
    ].filter((stream): stream is VoiceRtcStreamTelemetry => !!stream)

    const timestamp = Math.max(
      ...[transport, microphone, screenAudio, video]
        .filter((sample): sample is Sample => !!sample)
        .map((sample) => sample.timestampMs),
    )
    const metrics = transport?.metrics
    return {
      timestamp,
      transport: metrics
        ? defined({
            pingMs: round(nonNegative(metrics, 'ping_ms')),
            availableOutgoingBitrate: nonNegative(metrics, 'available_outgoing_bitrate'),
            availableIncomingBitrate: nonNegative(metrics, 'available_incoming_bitrate'),
            bytesSent: nonNegative(metrics, 'bytes_sent'),
            bytesReceived: nonNegative(metrics, 'bytes_received'),
            packetsSent: nonNegative(metrics, 'packets_sent'),
            packetsReceived: nonNegative(metrics, 'packets_received'),
          })
        : {},
      outbound,
      inbound,
    }
  }
}
