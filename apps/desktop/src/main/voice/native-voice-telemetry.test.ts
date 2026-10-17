import { describe, expect, it } from 'vitest'
import { isVoiceRtcTelemetrySnapshot } from '@syrnike13/platform'
import type { MediaLifecycleDiagnosticEvent } from '../media-runtime/contract'
import {
  NATIVE_VOICE_TELEMETRY_STALE_MS,
  NativeVoiceTelemetry,
} from './native-voice-telemetry'

let sequence = 0
function diagnostic(
  code: string,
  metrics: Record<string, number>,
  timestampMs = 1_000,
): MediaLifecycleDiagnosticEvent {
  return {
    sequence: ++sequence,
    timestampMs,
    component: 'network',
    operation: 'sample',
    code,
    metrics: Object.entries(metrics).map(([name, value]) => ({ name, value })),
  }
}

const transportMetrics = {
  sampled_at_ms: 10,
  ping_ms: 41.6,
  available_outgoing_bitrate: 2_000_000,
  available_incoming_bitrate: -1,
  bytes_sent: 10_000,
  bytes_received: 20_000,
  packets_sent: 100,
  packets_received: 200,
  audio_packets_sent: 90,
  audio_bytes_sent: 9_000,
  audio_remote_packets_lost: 2,
  audio_remote_fraction_lost: 0.015,
  audio_remote_rtt_ms: 44,
  audio_remote_jitter_ms: 3,
}

describe('NativeVoiceTelemetry', () => {
  it('is empty until the engine reports network metrics', () => {
    const telemetry = new NativeVoiceTelemetry(() => 0)
    expect(telemetry.snapshot()).toBeNull()
    telemetry.observe(diagnostic('microphone_metrics', { level: 1 }))
    expect(telemetry.snapshot()).toBeNull()
  })

  it('projects native diagnostics into the renderer telemetry contract', () => {
    const telemetry = new NativeVoiceTelemetry(() => 0)
    telemetry.observe(diagnostic('transport_network_metrics', transportMetrics, 5_000))
    telemetry.observe(diagnostic('remote_microphone_network_metrics', {
      streams: 2, packets_received: 500, packets_lost: -1, bytes_received: 40_000,
      total_samples_received: 96_000, jitter_max_ms: 12, concealed_samples: 30,
      silent_concealed_samples: 0, concealment_events: 1, jitter_buffer_delay: 1.5,
      jitter_buffer_emitted_count: 9_000, sampled_at_ms: 3, unmapped_streams: 0,
      reports_truncated: 0, inserted_samples_for_deceleration: 0,
      removed_samples_for_acceleration: 0,
    }, 4_000))
    telemetry.observe(diagnostic('remote_video_network_metrics', { streams: 0 }, 4_000))

    const snapshot = telemetry.snapshot()
    expect(isVoiceRtcTelemetrySnapshot(snapshot)).toBe(true)
    expect(snapshot).toMatchObject({
      timestamp: 5_000,
      transport: {
        pingMs: 42,
        availableOutgoingBitrate: 2_000_000,
        bytesSent: 10_000,
        bytesReceived: 20_000,
      },
      outbound: [{
        id: 'native:outbound:audio', pcRole: 'publisher', kind: 'audio',
        packetsSent: 90, packetsLost: 2, packetLossPercent: 1.5, roundTripTimeMs: 44,
      }],
      inbound: [{
        id: 'native:inbound:microphone', pcRole: 'subscriber', kind: 'audio',
        packetsReceived: 500, packetsLost: -1, jitter: 0.012, totalSamplesReceived: 96_000,
      }],
    })
    expect(snapshot?.transport).not.toHaveProperty('availableIncomingBitrate')
  })

  it('does not present a repeated getStats result as a new sample', () => {
    const telemetry = new NativeVoiceTelemetry(() => 0)
    telemetry.observe(diagnostic('transport_network_metrics', transportMetrics, 1_000))
    telemetry.observe(diagnostic('transport_network_metrics', transportMetrics, 2_000))
    expect(telemetry.snapshot()?.timestamp).toBe(1_000)
    telemetry.observe(diagnostic('transport_network_metrics', { ...transportMetrics, sampled_at_ms: 11 }, 3_000))
    expect(telemetry.snapshot()?.timestamp).toBe(3_000)
  })

  it('drops stale metrics and resets with the Room', () => {
    let now = 0
    const telemetry = new NativeVoiceTelemetry(() => now)
    telemetry.observe(diagnostic('transport_network_metrics', transportMetrics))
    now = NATIVE_VOICE_TELEMETRY_STALE_MS + 1
    expect(telemetry.snapshot()).toBeNull()
    now = 0
    telemetry.observe(diagnostic('transport_network_metrics', { ...transportMetrics, sampled_at_ms: 99 }))
    telemetry.reset()
    expect(telemetry.snapshot()).toBeNull()
  })
})
