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

describe('screen stream report bundle', () => {
  beforeEach(async () => {
    state.userData = await mkdtemp(path.join(tmpdir(), 'syrnike-screen-report-'))
  })

  it('preserves viewer, publisher, RTP, GPU, and audio evidence in one bundle', async () => {
    const session = path.join(
      state.userData,
      'logs',
      'native-media-diagnostics',
      'native-media-screen-report',
    )
    await mkdir(session, { recursive: true })
    await writeFile(
      path.join(session, 'electron-main.jsonl'),
      [
        JSON.stringify({
          schema: 'syrnike.diagnostic',
          version: 1,
          record_type: 'event',
          timestamp_ms: 10,
          source: 'electron-main',
          event: 'native-video.presentation_stalled',
          data: {
            scope: 'native-video',
            reason: 'retained-budget-exhausted',
            metrics: {
              retainedFrames: 6,
              rejectedFrames: 18_000,
              oldestRetainedAgeMs: 600_000,
            },
          },
        }),
        JSON.stringify({
          schema: 'syrnike.diagnostic',
          version: 1,
          record_type: 'event',
          timestamp_ms: 11,
          source: 'electron-main',
          event: 'desktop-voice.screen_pipeline_stalled',
          data: {
            reason: 'encoder_output_stalled',
            metrics: {
              videoFrames: 12_000,
              rtpFramesEncoded: 11_998,
              rtpFramesSent: 11_997,
              audioPackets: 9_000,
            },
          },
        }),
      ].join('\n'),
      'utf8',
    )

    const compressed = await createDesktopDiagnosticBundle(
      [
        JSON.stringify({
          schema: 'syrnike.diagnostic',
          version: 1,
          record_type: 'manifest',
          timestamp_ms: 1,
          source: 'renderer',
          event: 'report_manifest',
          data: {},
        }),
        JSON.stringify({
          schema: 'syrnike.diagnostic',
          version: 1,
          record_type: 'event',
          timestamp_ms: 12,
          source: 'renderer',
          event: 'rtc.health_incident',
          data: {
            payload: {
              triggerCode: 'rtc_audio_concealment_critical',
              quality: { concealedAudioPercent: 35 },
            },
          },
        }),
      ].join('\n'),
    )

    const records = gunzipSync(compressed)
      .toString('utf8')
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'native-video.presentation_stalled',
        data: expect.objectContaining({
          metrics: expect.objectContaining({
            retainedFrames: 6,
            rejectedFrames: 18_000,
          }),
        }),
      }),
      expect.objectContaining({
        event: 'desktop-voice.screen_pipeline_stalled',
        data: expect.objectContaining({
          metrics: expect.objectContaining({
            rtpFramesEncoded: 11_998,
            audioPackets: 9_000,
          }),
        }),
      }),
      expect.objectContaining({
        event: 'rtc.health_incident',
      }),
    ]))
  })
})
