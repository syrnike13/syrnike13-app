import { describe, expect, it, vi } from 'vitest'

import type { DiagnosticLogRecord } from '../native-runtime/diagnostic-log'
import {
  createMediaIncidentTimeline,
  isMediaTimelineFrameSampled,
} from './media-incident-timeline'
import {
  NativeSharedTextureBridge,
  type NativeSharedVideoFrame,
  type SharedTextureBridgeDependencies,
} from './shared-texture-bridge'

type ImportTextureOptions = Parameters<
  NonNullable<SharedTextureBridgeDependencies['importTexture']>
>[0]

function sampledFrame(): NativeSharedVideoFrame {
  for (let timestampUs = 1; timestampUs < 100_000; timestampUs += 1) {
    const candidate: NativeSharedVideoFrame = {
      sessionId: 'session-video',
      generation: 7,
      trackId: 'track-video',
      participantIdentity: 'private-person',
      source: 'camera',
      local: false,
      sequence: 701,
      width: 64,
      height: 64,
      timestampUs,
      runtimeEpoch: 3,
      ntHandle: Buffer.alloc(8),
    }
    if (isMediaTimelineFrameSampled({
      ...candidate,
      frameSequence: candidate.sequence,
      nativeCaptureTimestampUs: candidate.timestampUs,
    })) return candidate
  }
  throw new Error('no sampled frame found')
}

function createHarness(
  release: SharedTextureBridgeDependencies['release'] = vi.fn(),
) {
  let now = 10
  const records: DiagnosticLogRecord[] = []
  const callbacks: Array<() => void> = []
  const timeline = createMediaIncidentTimeline({
    record: (record) => records.push(record),
    now: () => now,
  })
  const sendTexture = vi.fn(async () => undefined)
  const bridge = new NativeSharedTextureBridge({
    getWindow: () => ({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, mainFrame: {} },
    }) as never,
    release,
    releaseAttempts: 1,
    maxInFlight: 1,
    stallTimeoutMs: 1_000,
    timeline,
    now: () => now,
    importTexture: vi.fn((options: ImportTextureOptions) => {
      callbacks.push(options.allReferencesReleased!)
      return {
        textureId: 'texture',
        release: vi.fn(),
        getVideoFrame: vi.fn(),
        subtle: {} as Electron.SharedTextureImportedSubtle,
      } as never
    }),
    sendTexture,
  })
  return {
    bridge,
    callbacks,
    records,
    sendTexture,
    setNow: (value: number) => {
      now = value
    },
  }
}

describe('shared texture media timeline', () => {
  it('separates Electron import and renderer handoff metadata', async () => {
    const h = createHarness()
    const frame = sampledFrame()

    expect(await h.bridge.deliver(frame)).toBe(true)

    expect(h.records.map((record) => record.stage)).toEqual([
      'electron_imported',
      'renderer_handoff',
    ])
    expect(h.sendTexture).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: frame.sessionId,
        generation: frame.generation,
        trackId: frame.trackId,
        sequence: frame.sequence,
        nativeCaptureTimestampUs: frame.timestampUs,
        runtimeEpoch: frame.runtimeEpoch,
        peerAlias: 'peer-1',
        timelineSampled: true,
        electronImportedAtMs: 10,
      }),
    )
    expect(JSON.stringify(h.records)).not.toContain('private-person')
  })

  it('always records a held renderer fence and its late release', async () => {
    vi.useFakeTimers()
    try {
      const h = createHarness()
      const frame = { ...sampledFrame(), timestampUs: 1 }
      while (isMediaTimelineFrameSampled({
        ...frame,
        frameSequence: frame.sequence,
        nativeCaptureTimestampUs: frame.timestampUs,
      })) frame.timestampUs += 1

      expect(await h.bridge.deliver(frame)).toBe(true)
      h.setNow(1_010)
      await vi.advanceTimersByTimeAsync(1_000)

      expect(h.records).toContainEqual(expect.objectContaining({
        stage: 'renderer_recovery',
        reason: 'shared-texture-fence',
        durationMs: 1_000,
      }))

      h.setNow(2_010)
      h.callbacks[0]!()
      await vi.advanceTimersByTimeAsync(0)

      expect(h.records).toContainEqual(expect.objectContaining({
        stage: 'renderer_fenced',
        reason: 'shared-texture-fence',
        durationMs: 2_000,
        metrics: expect.objectContaining({
          trackActiveReferences: 0,
          trackRetiredReferences: 1,
        }),
      }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('measures release request latency from first enqueue through native ack', async () => {
    let acknowledge!: () => void
    const release = vi.fn(() => new Promise<void>((resolve) => {
      acknowledge = resolve
    }))
    const h = createHarness(release)
    const frame = sampledFrame()
    await h.bridge.deliver(frame)

    h.setNow(40)
    h.callbacks[0]!()
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1))
    h.setNow(115)
    acknowledge()
    await vi.waitFor(() =>
      expect(h.records).toContainEqual(expect.objectContaining({
        stage: 'native_released',
        outcome: 'acknowledged',
        durationMs: 75,
      })),
    )
  })

  it('records the final native release timeout as an anomaly', async () => {
    const h = createHarness(async () => {
      h.setNow(90)
      throw new Error('native request deadline')
    })
    const frame = { ...sampledFrame(), timestampUs: 1 }
    while (isMediaTimelineFrameSampled({
      ...frame,
      frameSequence: frame.sequence,
      nativeCaptureTimestampUs: frame.timestampUs,
    })) frame.timestampUs += 1
    await h.bridge.deliver(frame)

    h.setNow(50)
    h.callbacks[0]!()
    await vi.waitFor(() =>
      expect(h.records).toContainEqual(expect.objectContaining({
        stage: 'native_release_timeout',
        reason: 'native-release-timeout',
        outcome: 'timeout',
        durationMs: 40,
      })),
    )
  })
})
