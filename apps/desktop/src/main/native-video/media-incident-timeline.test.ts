import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

import type { DiagnosticLogRecord } from '../native-runtime/diagnostic-log'
import {
  createMediaIncidentTimeline,
  isMediaTimelineFrameSampled,
  type MediaTimelineFrame,
} from './media-incident-timeline'

function frame(overrides: Partial<MediaTimelineFrame> = {}): MediaTimelineFrame {
  return {
    sessionId: 'session-7',
    generation: 3,
    trackId: 'track-video',
    participantIdentity: 'secret-participant',
    frameSequence: 91,
    nativeCaptureTimestampUs: 4_200_000,
    runtimeEpoch: 2,
    ...overrides,
  }
}

function samplerGoldenVectors() {
  const artifact = readFileSync(new URL(
    '../../../../../test-fixtures/media-timeline-sampler-vectors.tsv',
    import.meta.url,
  ), 'utf8')
  const [header, ...rows] = artifact.trimEnd().split('\n')
  expect(header?.replace(/\r$/, '')).toBe(
    'session_id\tgeneration\ttrack_id\tnative_capture_timestamp_us\tsampled',
  )
  return rows.filter(Boolean).map((row) => {
    const fields = row.replace(/\r$/, '').split('\t')
    expect(fields).toHaveLength(5)
    return {
      sessionId: fields[0]!,
      generation: Number(fields[1]),
      trackId: fields[2]!,
      nativeCaptureTimestampUs: Number(fields[3]),
      sampled: fields[4] === '1',
    }
  })
}

describe('media incident timeline', () => {
  it('matches the shared cross-language sampler golden vectors', () => {
    for (const golden of samplerGoldenVectors()) {
      expect(isMediaTimelineFrameSampled(golden)).toBe(golden.sampled)
    }
  })

  it('samples the exact frame correlation deterministically', () => {
    expect(isMediaTimelineFrameSampled(frame({
      nativeCaptureTimestampUs: 94,
    }))).toBe(true)
    expect(isMediaTimelineFrameSampled(frame({
      nativeCaptureTimestampUs: 95,
    }))).toBe(false)

    const candidate = Array.from({ length: 1_000 }, (_, index) =>
      frame({ nativeCaptureTimestampUs: index * 33_333 })
    ).find(isMediaTimelineFrameSampled)
    expect(candidate).toBeDefined()

    expect(isMediaTimelineFrameSampled(candidate!)).toBe(true)
    expect(isMediaTimelineFrameSampled({ ...candidate! })).toBe(true)
    expect(
      isMediaTimelineFrameSampled({
        ...candidate!,
        trackId: `${candidate!.trackId}-other`,
      }),
    ).not.toBe(true)
  })

  it('emits sampled boundaries and always emits ownership anomalies', () => {
    const records: DiagnosticLogRecord[] = []
    const timeline = createMediaIncidentTimeline({
      record: (record) => records.push(record),
      now: () => 1_000,
      maximumPeerAliases: 2,
    })
    const unsampled = Array.from({ length: 1_000 }, (_, index) =>
      frame({ nativeCaptureTimestampUs: index + 1 })
    ).find((candidate) => !isMediaTimelineFrameSampled(candidate))!

    timeline.recordVideo('electron_imported', unsampled, {
      durationMs: 4,
      metrics: { retainedFrames: 1 },
    })
    expect(records).toHaveLength(0)

    timeline.recordVideo('renderer_fenced', unsampled, {
      anomaly: 'shared-texture-fence',
      durationMs: 5_000,
      metrics: { retainedFrames: 3, retainedBytes: 12_288 },
    })

    expect(records).toEqual([
      expect.objectContaining({
        scope: 'native-video',
        event: 'media_timeline',
        stage: 'renderer_fenced',
        sessionId: 'session-7',
        generation: 3,
        trackId: 'track-video',
        frameSequence: 91,
        nativeCaptureTimestampUs: unsampled.nativeCaptureTimestampUs,
        runtimeEpoch: 2,
        peerAlias: 'peer-1',
        reason: 'shared-texture-fence',
        durationMs: 5_000,
        metrics: { retainedFrames: 3, retainedBytes: 12_288 },
      }),
    ])
    expect(JSON.stringify(records)).not.toContain('secret-participant')
  })

  it('keeps participant correlation ownership bounded', () => {
    const record = vi.fn()
    const timeline = createMediaIncidentTimeline({
      record,
      maximumPeerAliases: 2,
    })

    const first = timeline.correlate(frame({ participantIdentity: 'one' }))
    const second = timeline.correlate(frame({ participantIdentity: 'two' }))
    const third = timeline.correlate(frame({ participantIdentity: 'three' }))

    expect(first.peerAlias).toBe('peer-1')
    expect(second.peerAlias).toBe('peer-2')
    expect(third.peerAlias).toBe('peer-3')
    expect(timeline.snapshot()).toEqual(expect.objectContaining({
      peerAliases: 2,
      maximumPeerAliases: 2,
    }))
    expect(
      timeline.correlate(frame({ participantIdentity: 'one' })).peerAlias,
    ).toBe('peer-4')
  })

  it('never lets a diagnostic sink failure change media behavior', () => {
    const timeline = createMediaIncidentTimeline({
      record: () => {
        throw new Error('diagnostic sink unavailable')
      },
    })

    expect(() => timeline.recordVideo('renderer_recovery', frame(), {
      anomaly: 'held-fence',
    })).not.toThrow()
  })

  it('records WebRTC jitter separately from native playout metrics', () => {
    const records: DiagnosticLogRecord[] = []
    let now = 1_000
    const timeline = createMediaIncidentTimeline({
      record: (record) => records.push(record),
      now: () => now,
      maximumAudioStreams: 2,
    })

    const audioObservation = {
      sessionId: 'voice-session',
      generation: 8,
      trackId: 'audio-track',
      runtimeEpoch: 4,
      jitterBufferDelayMs: 13,
      jitterBufferTargetDelayMs: 21,
      jitterBufferEmittedCount: 34,
      webRtcJitterMs: 5,
    }
    timeline.recordAudioRtc(audioObservation)
    timeline.recordAudioRtc({ ...audioObservation, webRtcJitterMs: 99 })
    now += 5_000
    timeline.recordAudioRtc({ ...audioObservation, webRtcJitterMs: 6 })

    expect(records).toEqual([
      expect.objectContaining({
        scope: 'desktop-voice',
        event: 'media_timeline',
        stage: 'webrtc_jitter',
        sessionId: 'voice-session',
        generation: 8,
        trackId: 'audio-track',
        runtimeEpoch: 4,
        metrics: {
          jitterBufferDelayMs: 13,
          jitterBufferTargetDelayMs: 21,
          jitterBufferEmittedCount: 34,
          webRtcJitterMs: 5,
        },
      }),
      expect.objectContaining({
        stage: 'webrtc_jitter',
        metrics: expect.objectContaining({ webRtcJitterMs: 6 }),
      }),
    ])

    timeline.recordAudioRtc({ ...audioObservation, trackId: 'second' })
    timeline.recordAudioRtc({ ...audioObservation, trackId: 'third' })
    expect(timeline.snapshot()).toEqual({
      peerAliases: 0,
      maximumPeerAliases: 64,
      audioStreams: 2,
      maximumAudioStreams: 2,
    })
  })
})
