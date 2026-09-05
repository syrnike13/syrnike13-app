import { VideoBufferType, type VideoFrame } from '@livekit/rtc-node'

export const MARKER_MAGIC = 0x534d
export const MARKER_BITS = 144
export const MARKER_COLUMNS = 24
export const MARKER_ROWS = 6
export const MARKER_TILE_SIZE = 12

export interface VideoMarker {
  readonly sequence: number
  readonly capturedAtMs: number
  readonly generation: number
  readonly sourceWidth: number
  readonly sourceHeight: number
}

export function videoMarkerLatency(
  capturedAtMs: number,
  receivedAtMs: number,
  timeoutMs: number,
): number | undefined {
  const latency = receivedAtMs - capturedAtMs
  return latency >= 0 && latency < timeoutMs ? latency : undefined
}

export function decodeVideoMarker(frame: VideoFrame): VideoMarker | undefined {
  const i420 = frame.type === VideoBufferType.I420
    ? frame
    : frame.convert(VideoBufferType.I420)
  if (
    i420.width < MARKER_COLUMNS * MARKER_TILE_SIZE ||
    i420.height < MARKER_ROWS * MARKER_TILE_SIZE
  ) return undefined

  const bits: number[] = []
  for (let bit = 0; bit < MARKER_BITS; bit += 1) {
    const column = bit % MARKER_COLUMNS
    const row = Math.floor(bit / MARKER_COLUMNS)
    const centerX = column * MARKER_TILE_SIZE + Math.floor(MARKER_TILE_SIZE / 2)
    const centerY = row * MARKER_TILE_SIZE + Math.floor(MARKER_TILE_SIZE / 2)
    bits.push(i420.data[centerY * i420.width + centerX]! >= 128 ? 1 : 0)
  }

  const magic = Number(readBits(bits, 0, 16))
  if (magic !== MARKER_MAGIC) return undefined
  const sequence = Number(readBits(bits, 16, 32))
  const capturedAtMs = Number(readBits(bits, 48, 48))
  const generation = Number(readBits(bits, 96, 16))
  const sourceWidth = Number(readBits(bits, 112, 16))
  const sourceHeight = Number(readBits(bits, 128, 16))
  if (
    !Number.isSafeInteger(sequence) || !Number.isSafeInteger(capturedAtMs) ||
    generation <= 0 || sourceWidth <= 0 || sourceHeight <= 0
  ) {
    return undefined
  }
  return { sequence, capturedAtMs, generation, sourceWidth, sourceHeight }
}

export function sampleVideoContent(frame: VideoFrame): readonly number[] {
  const i420 = frame.type === VideoBufferType.I420
    ? frame
    : frame.convert(VideoBufferType.I420)
  const markerBottom = MARKER_ROWS * MARKER_TILE_SIZE
  if (i420.width === 0 || i420.height <= markerBottom) return []
  const samples: number[] = []
  for (let sampleY = 0; sampleY < 8; sampleY += 1) {
    const y = markerBottom + Math.floor(
      (sampleY + 0.5) * (i420.height - markerBottom) / 8,
    )
    for (let sampleX = 0; sampleX < 8; sampleX += 1) {
      const x = Math.min(
        i420.width - 1,
        Math.floor((sampleX + 0.5) * i420.width / 8),
      )
      const value = i420.data[y * i420.width + x]
      if (value === undefined) return []
      samples.push(value)
    }
  }
  return samples
}

function readBits(bits: readonly number[], offset: number, length: number): bigint {
  let value = 0n
  for (let index = offset; index < offset + length; index += 1) {
    value = (value << 1n) | BigInt(bits[index] ?? 0)
  }
  return value
}
