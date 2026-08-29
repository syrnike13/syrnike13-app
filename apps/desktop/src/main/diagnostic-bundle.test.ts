import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
}))

import { createDesktopDiagnosticBundle } from './diagnostic-bundle'

describe('desktop diagnostic bundle', () => {
  beforeEach(async () => {
    state.userData = await mkdtemp(path.join(tmpdir(), 'syrnike-diagnostics-'))
  })

  it('combines renderer and redacted native JSONL into gzip', async () => {
    const session = path.join(
      state.userData,
      'logs',
      'native-media-diagnostics',
      'native-media-test',
    )
    await mkdir(session, { recursive: true })
    await writeFile(
      path.join(session, 'native.jsonl'),
      '{"role":"native","event":"screen_started"}\n',
      'utf8',
    )

    const compressed = await createDesktopDiagnosticBundle(
      '{"type":"manifest","source":"desktop"}\n{"event":"voice_failed"}',
    )
    const value = gunzipSync(compressed).toString('utf8')
    expect(value).toContain('voice_failed')
    expect(value).toContain('screen_started')
    const records = value.split('\n').map((line) => JSON.parse(line))
    expect(records[0]).toMatchObject({ record_type: 'manifest' })
    expect(records).toContainEqual(
      expect.objectContaining({
        source: 'electron-main',
        event: 'diagnostic.bundle_inventory',
        data: expect.objectContaining({
          native_limit_bytes: 30 * 1024 * 1024,
          native_sessions_found: 1,
          native_files_included: 1,
          native_records_included: 1,
          native_records_by_source: { native: 1 },
        }),
      }),
    )
    for (const record of records) {
      expect(record).toMatchObject({
        schema: 'syrnike.diagnostic',
        version: 1,
      })
    }
  })

  it('reconstructs one redacted correlated media incident timeline', async () => {
    const session = path.join(
      state.userData,
      'logs',
      'native-media-diagnostics',
      'native-media-correlated',
    )
    await mkdir(session, { recursive: true })
    await writeFile(
      path.join(session, 'native.jsonl'),
      [
        {
          role: 'native',
          event: 'media_timeline',
          wallTimeUnixMs: 100,
          stage: 'native_published',
          sessionId: 'session-1',
          generation: 4,
          trackId: 'track-7',
          frameSequence: 81,
          nativeCaptureTimestampUs: 9_000,
          participantIdentity: 'participant-secret',
          token: 'token-secret',
          activeLeases: 2,
          retiredLeases: 1,
          poolGenerations: 2,
          estimatedBackingBytes: 16_777_216,
          gpuCompletionTimeouts: 1,
          rollovers: 1,
        },
        {
          role: 'native',
          event: 'media_runtime_command_start',
          wallTimeUnixMs: 120,
          queue: 'voice',
          command: 'connectVoice',
          sessionId: 'session-1',
          generation: 4,
          queueWaitMs: 20_000,
          deadlineMs: 20_000,
          outcome: 'deadline',
        },
        {
          role: 'native',
          event: 'remote_audio_direct_dataplane',
          wallTimeUnixMs: 130,
          trackId: 'audio-3',
          scheduledPlayoutAgeMs: 83,
          oldestQueuedAgeMs: 91,
          queuedPackets: 8,
          endpointPaddingMs: 0,
          rendererWakeGapMs: 42,
          clockAdjustmentPpm: 1_000,
        },
        {
          role: 'native',
          event: 'remote_audio_renderer_mmcss',
          wallTimeUnixMs: 135,
          rendererEpoch: 5,
          registered: false,
          win32Error: 5,
        },
        {
          role: 'native',
          event: 'remote_audio_renderer_dataplane',
          wallTimeUnixMs: 140,
          rendererEpoch: 5,
          maximumWakeGapMs: 57,
          zeroPaddingEvents: 2,
          mmcssRegistered: false,
        },
        {
          role: 'native',
          event: 'native_event_control_backpressure_timeout',
          wallTimeUnixMs: 148,
          queueDepth: 512,
        },
        {
          role: 'native',
          event: 'native_cleanup_state',
          wallTimeUnixMs: 150,
          outcome: 'saturated',
          activeJobs: 2,
          backlogJobs: 8,
          workerThreads: 2,
          workerHandles: 2,
          saturatedSubmissions: 1,
        },
        {
          role: 'native',
          event: 'native_cleanup_shutdown',
          wallTimeUnixMs: 155,
          outcome: 'deadline',
          deadlineBudgetMs: 2_000,
          elapsedMs: 2_001,
          unfinishedJobs: 1,
        },
      ].map((record) => JSON.stringify(record)).join('\n'),
      'utf8',
    )
    await writeFile(
      path.join(session, 'electron-main.jsonl'),
      JSON.stringify({
        schema: 'syrnike.diagnostic',
        version: 1,
        record_type: 'event',
        timestamp_ms: 180,
        source: 'electron-main',
        event: 'native-video.media_timeline',
        data: {
          runtime: 'media',
          payload: {
            scope: 'native-video',
            stage: 'native_released',
            sessionId: 'session-1',
            generation: 4,
            trackId: 'track-7',
            frameSequence: 81,
            nativeCaptureTimestampUs: 9_000,
            runtimeEpoch: 2,
            durationMs: 75,
          },
        },
      }),
      'utf8',
    )

    const rendererEvent = JSON.stringify({
      schema: 'syrnike.diagnostic',
      version: 1,
      record_type: 'event',
      timestamp_ms: 160,
      source: 'renderer',
      event: 'native-video.media_timeline',
      data: {
        payload: {
          stage: 'renderer_presented',
          sessionId: 'session-1',
          generation: 4,
          trackId: 'track-7',
          frameSequence: 81,
          nativeCaptureTimestampUs: 9_000,
          runtimeEpoch: 2,
          participantIdentity: 'renderer-secret',
        },
      },
    })
    const compressed = await createDesktopDiagnosticBundle(
      `{"type":"manifest","source":"desktop"}\n${rendererEvent}`,
    )
    const records = gunzipSync(compressed).toString('utf8')
      .split('\n')
      .map((line) => JSON.parse(line))
    const incident = records.filter((record) =>
      record.event === 'media_timeline' ||
      record.event === 'native-video.media_timeline' ||
      record.event === 'media_runtime_command_start' ||
      record.event.startsWith('remote_audio_') ||
      record.event.startsWith('native_event_control_') ||
      record.event.startsWith('native_cleanup_')
    )

    expect(incident.map((record) => record.timestamp_ms)).toEqual([
      100,
      120,
      130,
      135,
      140,
      148,
      150,
      155,
      160,
      180,
    ])
    expect(incident.at(-2)).toMatchObject({
      source: 'renderer',
      data: {
        payload: {
          stage: 'renderer_presented',
          sessionId: 'session-1',
          generation: 4,
          trackId: 'track-7',
          frameSequence: 81,
          nativeCaptureTimestampUs: 9_000,
          runtimeEpoch: 2,
        },
      },
    })
    expect(incident.at(-1)).toMatchObject({
      source: 'electron-main',
      data: {
        payload: { stage: 'native_released', durationMs: 75 },
      },
    })
    const correlatedVideo = incident
      .filter((record) => record.event.includes('media_timeline'))
      .map((record) => record.data.payload ?? record.data)
    expect(correlatedVideo).toHaveLength(3)
    for (const frame of correlatedVideo) {
      expect(frame).toMatchObject({
        sessionId: 'session-1',
        generation: 4,
        trackId: 'track-7',
        frameSequence: 81,
        nativeCaptureTimestampUs: 9_000,
      })
    }
    expect(incident).toContainEqual(expect.objectContaining({
      event: 'remote_audio_direct_dataplane',
      data: expect.objectContaining({
        scheduledPlayoutAgeMs: 83,
        oldestQueuedAgeMs: 91,
        queuedPackets: 8,
        endpointPaddingMs: 0,
        rendererWakeGapMs: 42,
        clockAdjustmentPpm: 1_000,
      }),
    }))
    expect(incident).toContainEqual(expect.objectContaining({
      event: 'remote_audio_renderer_mmcss',
      data: expect.objectContaining({ registered: false, win32Error: 5 }),
    }))
    expect(incident).toContainEqual(expect.objectContaining({
      event: 'native_event_control_backpressure_timeout',
      data: expect.objectContaining({ queueDepth: 512 }),
    }))
    expect(incident).toContainEqual(expect.objectContaining({
      event: 'native_cleanup_shutdown',
      data: expect.objectContaining({
        outcome: 'deadline',
        unfinishedJobs: 1,
      }),
    }))
    expect(JSON.stringify(records)).not.toContain('participant-secret')
    expect(JSON.stringify(records)).not.toContain('renderer-secret')
    expect(JSON.stringify(records)).not.toContain('token-secret')
    expect(compressed.byteLength).toBeLessThanOrEqual(10 * 1024 * 1024)
  })

  it('rejects unbounded renderer input', async () => {
    await expect(
      createDesktopDiagnosticBundle('x'.repeat(2 * 1024 * 1024 + 1)),
    ).rejects.toThrow('too large')
  })

  it('caps the normalized bundle below the backend decompressed limit', async () => {
    const session = path.join(
      state.userData,
      'logs',
      'native-media-diagnostics',
      'native-media-large',
    )
    await mkdir(session, { recursive: true })
    const record = `${JSON.stringify({
      role: 'native',
      event: 'trace_packet_processed',
      wallTimeUnixMs: 1,
      detail: 'x'.repeat(220),
    })}\n`
    const nativeJsonl = record.repeat(
      Math.ceil((30 * 1024 * 1024) / Buffer.byteLength(record)),
    )
    await writeFile(path.join(session, 'native.jsonl'), nativeJsonl, 'utf8')

    const compressed = await createDesktopDiagnosticBundle(
      '{"type":"manifest","source":"desktop"}\n{"event":"voice_failed"}',
    )
    expect(gunzipSync(compressed).byteLength).toBeLessThanOrEqual(33 * 1024 * 1024)
  }, 60_000)

  it('reduces native records when gzip output would exceed the upload limit', async () => {
    const session = path.join(
      state.userData,
      'logs',
      'native-media-diagnostics',
      'native-media-incompressible',
    )
    await mkdir(session, { recursive: true })
    const records = Array.from({ length: 5_000 }, (_, index) =>
      JSON.stringify({
        role: 'native',
        event: 'runtime_failed',
        wallTimeUnixMs: index,
        detail: randomBytes(3_072).toString('base64'),
      }),
    ).join('\n')
    await writeFile(path.join(session, 'native.jsonl'), records, 'utf8')

    const compressed = await createDesktopDiagnosticBundle(
      '{"type":"manifest","source":"desktop"}\n{"event":"voice_failed"}',
    )
    expect(compressed.byteLength).toBeLessThanOrEqual(10 * 1024 * 1024)
    const normalized = gunzipSync(compressed)
    expect(normalized.byteLength).toBeLessThanOrEqual(33 * 1024 * 1024)
    const inventory = normalized
      .toString('utf8')
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((record) => record.event === 'diagnostic.bundle_inventory')
    expect(inventory.data.native_selection_budget_bytes).toBeLessThan(
      30 * 1024 * 1024,
    )
  }, 30_000)
})
