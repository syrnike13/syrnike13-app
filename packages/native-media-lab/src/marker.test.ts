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
    const generation = 7
    const sourceWidth = 1_280
    const sourceHeight = 720
    const payload =
      (BigInt(MARKER_MAGIC) << 128n) |
      (BigInt(sequence) << 96n) |
      (BigInt(capturedAtMs) << 48n) |
      (BigInt(generation) << 32n) |
      (BigInt(sourceWidth) << 16n) |
      BigInt(sourceHeight)
    // Independent CRC-16/CCITT-FALSE vector shared with the native writer test.
    const value = (payload << 16n) | 0x8f28n

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
    ).toEqual({ sequence, capturedAtMs, generation, sourceWidth, sourceHeight })
    // Every single-bit payload/CRC corruption must be detected, including
    // timestamps which would otherwise remain plausible or lie in the future.
    for (let bit = 0; bit < MARKER_BITS; ++bit) {
      const damaged = data.slice()
      const x = (bit % MARKER_COLUMNS) * MARKER_TILE_SIZE
      const y = Math.floor(bit / MARKER_COLUMNS) * MARKER_TILE_SIZE
      const changed = data[y * width + x]! >= 128 ? 16 : 235
      for (let row = y; row < y + MARKER_TILE_SIZE; ++row)
        damaged.fill(changed, row * width + x, row * width + x + MARKER_TILE_SIZE)
      expect(decodeVideoMarker(new VideoFrame(damaged, width, height, VideoBufferType.I420)))
        .toBeUndefined()
    }
    // A damaged center pixel must not flip an otherwise uniform coded tile.
    for (let bit = 0; bit < MARKER_BITS; bit += 1) {
      const x = (bit % MARKER_COLUMNS) * MARKER_TILE_SIZE + Math.floor(MARKER_TILE_SIZE / 2)
      const y = Math.floor(bit / MARKER_COLUMNS) * MARKER_TILE_SIZE + Math.floor(MARKER_TILE_SIZE / 2)
      data[y * width + x] = data[y * width + x]! >= 128 ? 16 : 235
    }
    expect(decodeVideoMarker(new VideoFrame(data, width, height, VideoBufferType.I420)))
      .toEqual({ sequence, capturedAtMs, generation, sourceWidth, sourceHeight })
    expect(decodeVideoMarker(new VideoFrame(data, width, height, VideoBufferType.I420), 0)).toBeUndefined()
    // A changed sequence tile invalidates the checksum. Never repair metadata
    // from previous frames or treat damaged bits as a real sequence/timestamp.
    const sequenceBit = 47
    for (let y = MARKER_TILE_SIZE; y < 2 * MARKER_TILE_SIZE; y += 1)
      data.fill(235, y * width + (sequenceBit % MARKER_COLUMNS) * MARKER_TILE_SIZE,
        y * width + ((sequenceBit % MARKER_COLUMNS) + 1) * MARKER_TILE_SIZE)
    expect(decodeVideoMarker(new VideoFrame(data, width, height, VideoBufferType.I420)))
      .toBeUndefined()
  })

  it('rejects future and stale timestamps instead of bypassing latency checks', () => {
    expect(videoMarkerLatency(9_900, 10_000, 1_000)).toBe(100)
    expect(videoMarkerLatency(10_001, 10_000, 1_000)).toBeUndefined()
    expect(videoMarkerLatency(9_000, 10_000, 1_000)).toBeUndefined()
  })
})
