import { VideoBufferType, VideoFrame } from '@livekit/rtc-node'
import { describe, expect, it } from 'vitest'
import {
  decodeVideoMarker,
  MARKER_BITS,
  MARKER_COLUMNS,
  MARKER_MAGIC,
  MARKER_ROWS,
  MARKER_TILE_SIZE,
  videoMarkerLatency,
} from './marker.js'

describe('decodeVideoMarker', () => {
  it('decodes the luminance marker used by the C++ publisher', () => {
    const width = MARKER_COLUMNS * MARKER_TILE_SIZE
    const height = MARKER_ROWS * MARKER_TILE_SIZE
    const data = new Uint8Array(width * height * 3 / 2)
    data.fill(128)
    const sequence = 123_456
    const capturedAtMs = 1_788_000_123_456
    const value =
      (BigInt(MARKER_MAGIC) << 80n) |
      (BigInt(sequence) << 48n) |
      BigInt(capturedAtMs)

    for (let bit = 0; bit < MARKER_BITS; bit += 1) {
      const shift = BigInt(MARKER_BITS - bit - 1)
      const luminance = ((value >> shift) & 1n) === 1n ? 235 : 16
      const column = bit % MARKER_COLUMNS
      const row = Math.floor(bit / MARKER_COLUMNS)
      for (let y = row * MARKER_TILE_SIZE; y < (row + 1) * MARKER_TILE_SIZE; y += 1) {
        data.fill(
          luminance,
          y * width + column * MARKER_TILE_SIZE,
          y * width + (column + 1) * MARKER_TILE_SIZE,
        )
      }
    }

    expect(
      decodeVideoMarker(new VideoFrame(data, width, height, VideoBufferType.I420)),
    ).toEqual({ sequence, capturedAtMs })
  })

  it('rejects future and stale timestamps instead of bypassing latency checks', () => {
    expect(videoMarkerLatency(9_900, 10_000, 1_000)).toBe(100)
    expect(videoMarkerLatency(10_001, 10_000, 1_000)).toBeUndefined()
    expect(videoMarkerLatency(9_000, 10_000, 1_000)).toBeUndefined()
  })
})
