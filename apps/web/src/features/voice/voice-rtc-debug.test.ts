import { beforeEach, describe, expect, it } from 'vitest'

import {
  appendRtcDebugSample,
  collectVoiceRtcDebugSnapshot,
  deriveRtcRates,
  RTC_DEBUG_BROWSER_UNAVAILABLE,
} from './voice-rtc-debug'
import { nativeMediaEngineStatsStore } from './native-media-engine-stats'

function statsReport(records: Array<Record<string, unknown>>) {
  const map = new Map(records.map((record) => [record.id as string, record]))
  return {
    forEach: map.forEach.bind(map),
  } as unknown as RTCStatsReport
}

function roomWithStats(records: Array<Record<string, unknown>>) {
  return {
    engine: {
      pcManager: {
        publisher: {
          pc: {
            getStats: () => Promise.resolve(statsReport(records)),
          },
        },
      },
    },
  }
}

function roomWithPublisherAndSubscriberStats({
  publisher,
  subscriber,
}: {
  publisher: Array<Record<string, unknown>>
  subscriber: Array<Record<string, unknown>>
}) {
  return {
    engine: {
      pcManager: {
        publisher: {
          pc: {
            getStats: () => Promise.resolve(statsReport(publisher)),
          },
        },
        subscriber: {
          pc: {
            getStats: () => Promise.resolve(statsReport(subscriber)),
          },
        },
      },
    },
  }
}

describe('voice rtc debug', () => {
  beforeEach(() => {
    nativeMediaEngineStatsStore.reset()
  })

  it('collects transport, outbound, inbound, and screen share diagnostics from RTC stats', async () => {
    const snapshot = await collectVoiceRtcDebugSnapshot(
      roomWithStats([
        {
          id: 'codec-video',
          type: 'codec',
          mimeType: 'video/VP8',
          payloadType: 96,
        },
        {
          id: 'pair',
          type: 'candidate-pair',
          state: 'succeeded',
          nominated: true,
          currentRoundTripTime: 0.063,
          availableOutgoingBitrate: 6_000_000,
          availableIncomingBitrate: 7_000_000,
          bytesSent: 1_200,
          bytesReceived: 2_400,
          packetsSent: 12,
          packetsReceived: 24,
          localCandidateId: 'local',
          remoteCandidateId: 'remote',
        },
        {
          id: 'local',
          type: 'local-candidate',
          address: '10.0.0.2',
          port: 50100,
          protocol: 'udp',
        },
        {
          id: 'remote',
          type: 'remote-candidate',
          address: '195.209.213.95',
          port: 443,
          protocol: 'udp',
        },
        {
          id: 'out-video',
          type: 'outbound-rtp',
          kind: 'video',
          ssrc: 111,
          mid: '7',
          codecId: 'codec-video',
          bytesSent: 500_000,
          packetsSent: 450,
          framesEncoded: 120,
          framesPerSecond: 60,
          frameWidth: 1920,
          frameHeight: 1080,
          targetBitrate: 5_500_000,
          qualityLimitationReason: 'none',
          qualityLimitationDurations: {
            none: 12,
            cpu: 0,
          },
        },
        {
          id: 'in-video',
          type: 'inbound-rtp',
          kind: 'video',
          ssrc: 222,
          mid: '8',
          codecId: 'codec-video',
          bytesReceived: 750_000,
          packetsReceived: 700,
          packetsLost: 0,
          framesDecoded: 100,
          framesDropped: 2,
          framesPerSecond: 55,
          frameWidth: 1920,
          frameHeight: 1080,
        },
      ]),
      [
        {
          id: 'user:screen',
          userId: 'user',
          kind: 'screen',
          source: 'screen',
          isLocal: true,
          subscribed: true,
          live: true,
          track: {
            mediaStreamTrack: {
              contentHint: 'motion',
              getSettings: () => ({
                width: 1920,
                height: 1080,
                frameRate: 60,
                displaySurface: 'monitor',
              }),
            },
          },
          publication: {
            trackSid: 'TR_screen',
            source: 'screen_share',
            options: {
              videoCodec: 'vp8',
              screenShareEncoding: {
                maxBitrate: 8_000_000,
                maxFramerate: 60,
              },
              simulcast: false,
              degradationPreference: 'maintain-resolution',
            },
          },
        },
      ] as never,
      1_000,
    )

    expect(snapshot.transport.pingMs).toBe(63)
    expect(snapshot.transport.availableOutgoingBitrate).toBe(6_000_000)
    expect(snapshot.transport.localAddress).toBe('10.0.0.2:50100/udp')
    expect(snapshot.outbound[0]).toMatchObject({
      id: 'publisher:out-video',
      kind: 'video',
      codec: 'VP8 (96)',
      bytesSent: 500_000,
      frameWidth: 1920,
      frameHeight: 1080,
      qualityLimitationDurations: {
        none: 12,
        cpu: 0,
      },
    })
    expect(snapshot.inbound[0]).toMatchObject({
      id: 'publisher:in-video',
      kind: 'video',
      codec: 'VP8 (96)',
      bytesReceived: 750_000,
      packetsLost: 0,
    })
    expect(snapshot.screenShares[0]).toMatchObject({
      id: 'user:screen',
      ownerUserId: 'user',
      codec: 'vp8',
      maxBitrate: 8_000_000,
      captureWidth: 1920,
      captureHeight: 1080,
      hybridDxgiFrames: RTC_DEBUG_BROWSER_UNAVAILABLE,
    })
  })

  it('uses native helper dimensions for local native screen share diagnostics', async () => {
    nativeMediaEngineStatsStore.setNative(
      { wgc: 60, dxgi: 0, gdi_blt: 0 },
      'wgc',
      {
        mode: 'process',
        loopbackMode: 'include_target_process_tree',
        targetProcessId: 777,
      },
      {
        width: 1920,
        height: 1038,
        fps: 60,
        bitrate: 8_000_000,
        publishedVideo: true,
        publishedAudio: true,
        audioFrames: 96_000,
        audioPackets: 100,
        audioPeakDb: -6.5,
        audioRmsDb: -18.25,
        videoFrames: 120,
        videoIntervalFrames: 60,
        videoLateFrames: 0,
        videoAvgCaptureUs: 3200,
      },
    )

    const snapshot = await collectVoiceRtcDebugSnapshot(
      roomWithStats([]),
      [
        {
          id: 'user:screen',
          userId: 'user',
          kind: 'screen',
          source: 'screen',
          isLocal: true,
          subscribed: true,
          live: true,
          track: {
            mediaStreamTrack: {
              getSettings: () => ({
                width: 1920,
                height: 1080,
                frameRate: 30,
              }),
            },
          },
        },
      ] as never,
      1_000,
    )

    expect(snapshot.screenShares[0]).toMatchObject({
      captureBackend: 'native',
      captureMethod: 'wgc',
      captureVideoPublished: true,
      captureAudioPublished: true,
      captureWidth: 1920,
      captureHeight: 1038,
      captureFrameRate: 60,
      captureBitrate: 8_000_000,
      captureVideoFrames: 120,
      captureVideoIntervalFrames: 60,
      captureVideoLateFrames: 0,
      captureVideoAvgCaptureUs: 3200,
      captureAudioMode: 'process',
      captureAudioLoopbackMode: 'include_target_process_tree',
      captureAudioTargetProcessId: 777,
      captureAudioFrames: 96_000,
      captureAudioPackets: 100,
      captureAudioPeakDb: -6.5,
      captureAudioRmsDb: -18.25,
      hybridGraphicsCaptureFrames: 60,
    })
  })

  it('preserves audio receive and concealment counters needed to diagnose silence', async () => {
    const snapshot = await collectVoiceRtcDebugSnapshot(
      roomWithStats([
        {
          id: 'codec-opus',
          type: 'codec',
          mimeType: 'audio/opus',
          payloadType: 111,
          clockRate: 48_000,
          channels: 2,
        },
        {
          id: 'in-audio',
          type: 'inbound-rtp',
          kind: 'audio',
          codecId: 'codec-opus',
          bytesReceived: 24_000,
          packetsReceived: 100,
          audioLevel: 0,
          totalAudioEnergy: 0,
          totalSamplesDuration: 1,
          totalSamplesReceived: 48_000,
          concealedSamples: 480,
          silentConcealedSamples: 240,
          jitterBufferEmittedCount: 47_520,
        },
      ]),
      [],
      1_000,
    )

    expect(snapshot.inbound[0]).toMatchObject({
      kind: 'audio',
      codec: 'opus (111)',
      bytesReceived: 24_000,
      packetsReceived: 100,
      audioLevel: 0,
      totalAudioEnergy: 0,
      totalSamplesDuration: 1,
      totalSamplesReceived: 48_000,
      concealedSamples: 480,
      silentConcealedSamples: 240,
      jitterBufferEmittedCount: 47_520,
    })
  })

  it('sums transport counters from publisher and subscriber peer connections', async () => {
    const snapshot = await collectVoiceRtcDebugSnapshot(
      roomWithPublisherAndSubscriberStats({
        publisher: [
          {
            id: 'publisher-pair',
            type: 'candidate-pair',
            state: 'succeeded',
            nominated: true,
            bytesSent: 1_000,
            bytesReceived: 2_000,
            packetsSent: 10,
            packetsReceived: 20,
          },
        ],
        subscriber: [
          {
            id: 'subscriber-pair',
            type: 'candidate-pair',
            state: 'succeeded',
            nominated: true,
            bytesSent: 3_000,
            bytesReceived: 4_000,
            packetsSent: 30,
            packetsReceived: 40,
          },
        ],
      }),
      [],
      1_000,
    )

    expect(snapshot.transport.bytesSent).toBe(4_000)
    expect(snapshot.transport.bytesReceived).toBe(6_000)
    expect(snapshot.transport.packetsSent).toBe(40)
    expect(snapshot.transport.packetsReceived).toBe(60)
  })

  it('returns partial stats when one peer connection never resolves', async () => {
    const room = {
      engine: {
        pcManager: {
          publisher: {
            pc: { getStats: () => new Promise<RTCStatsReport>(() => undefined) },
          },
          subscriber: {
            pc: {
              getStats: () => Promise.resolve(statsReport([
                {
                  id: 'in-audio',
                  type: 'inbound-rtp',
                  kind: 'audio',
                  packetsReceived: 25,
                  bytesReceived: 4_000,
                  totalAudioEnergy: 0.5,
                },
              ])),
            },
          },
        },
      },
    }

    const snapshot = await collectVoiceRtcDebugSnapshot(
      room,
      [],
      1_000,
      5,
    )

    expect(snapshot.inbound).toContainEqual(
      expect.objectContaining({
        pcRole: 'subscriber',
        packetsReceived: 25,
        bytesReceived: 4_000,
        totalAudioEnergy: 0.5,
      }),
    )
  })

  it('drops invalid quality limitation durations from RTC stats', async () => {
    const snapshot = await collectVoiceRtcDebugSnapshot(
      roomWithStats([
        {
          id: 'out-video',
          type: 'outbound-rtp',
          kind: 'video',
          qualityLimitationDurations: {
            none: 12,
            cpu: 'bad',
          },
        },
      ]),
      [],
      1_000,
    )

    expect(snapshot.outbound[0]?.qualityLimitationDurations).toBeUndefined()
  })

  it('derives bitrates from byte deltas', () => {
    const previous = {
      timestamp: 1_000,
      transport: { bytesSent: 100, bytesReceived: 200 },
      outbound: [{ id: 'out', bytesSent: 1_000 }],
      inbound: [{ id: 'in', bytesReceived: 2_000 }],
      screenShares: [],
    }
    const current = {
      timestamp: 2_000,
      transport: { bytesSent: 600, bytesReceived: 1_200 },
      outbound: [{ id: 'out', bytesSent: 2_000 }],
      inbound: [{ id: 'in', bytesReceived: 4_000 }],
      screenShares: [],
    }

    expect(deriveRtcRates(previous, current)).toEqual({
      transport: {
        outboundBitrate: 4_000,
        inboundBitrate: 8_000,
      },
      outbound: { out: 8_000 },
      inbound: { in: 16_000 },
    })
  })

  it('keeps only the last 180 debug samples', () => {
    const history = Array.from({ length: 180 }, (_, index) => ({
      timestamp: index,
      transport: {},
      outbound: [],
      inbound: [],
      screenShares: [],
    }))

    const next = appendRtcDebugSample(history, {
      timestamp: 180,
      transport: {},
      outbound: [],
      inbound: [],
      screenShares: [],
    })

    expect(next).toHaveLength(180)
    expect(next[0]?.timestamp).toBe(1)
    expect(next[179]?.timestamp).toBe(180)
  })
})
