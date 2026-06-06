function isRecognizedNal(nal: Uint8Array) {
  if (nal.length === 0) return false
  const type = nalType(nal)
  return type === 1 || type === 5 || type === 6 || type === 7 || type === 8 || type === 9
}

export function splitAvcc(buffer: Uint8Array, littleEndian = false) {
  const units: Uint8Array[] = []
  let offset = 0
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)

  while (offset + 4 <= buffer.length) {
    const length = view.getUint32(offset, littleEndian)
    if (length === 0) break
    offset += 4
    if (offset + length > buffer.length) break
    units.push(buffer.slice(offset, offset + length))
    offset += length
  }

  return units
}

/** Annex-B, AVCC, or MF's `00 00 00 01` + AVCC sample. */
export function parseH264Nals(buffer: Uint8Array) {
  const annexNals = splitAnnexB(buffer)
  if (annexNals.length > 1) return annexNals
  if (annexNals.length === 1 && isRecognizedNal(annexNals[0]!)) {
    return annexNals
  }

  let payload = buffer
  if (
    buffer.length >= 4 &&
    buffer[0] === 0 &&
    buffer[1] === 0 &&
    buffer[2] === 0 &&
    buffer[3] === 1
  ) {
    payload = buffer.slice(4)
  } else if (
    buffer.length >= 3 &&
    buffer[0] === 0 &&
    buffer[1] === 0 &&
    buffer[2] === 1
  ) {
    payload = buffer.slice(3)
  }

  for (const littleEndian of [false, true]) {
    const avccNals = splitAvcc(payload, littleEndian)
    if (avccNals.length > 0 && avccNals.every(isRecognizedNal)) {
      return avccNals
    }
  }

  return annexNals
}

export function splitAnnexB(buffer: Uint8Array) {
  const units: Uint8Array[] = []
  let start = -1

  for (let index = 0; index <= buffer.length - 3; index += 1) {
    const isFourByte =
      buffer[index] === 0 &&
      buffer[index + 1] === 0 &&
      buffer[index + 2] === 0 &&
      buffer[index + 3] === 1
    const isThreeByte =
      !isFourByte &&
      buffer[index] === 0 &&
      buffer[index + 1] === 0 &&
      buffer[index + 2] === 1

    if (!isFourByte && !isThreeByte) continue

    const nextStart = index + (isFourByte ? 4 : 3)
    if (start >= 0) {
      units.push(buffer.slice(start, index))
    }
    start = nextStart
    index = nextStart - 1
  }

  if (start >= 0 && start < buffer.length) {
    units.push(buffer.slice(start))
  }

  return units
}

export function nalType(nal: Uint8Array) {
  return nal[0] & 0x1f
}

export function isH264KeyFrameNal(nal: Uint8Array) {
  const type = nalType(nal)
  return type === 5 || type === 7 || type === 8
}

export function extractSpsPps(nals: Uint8Array[]) {
  let sps: Uint8Array | null = null
  let pps: Uint8Array | null = null

  for (const nal of nals) {
    const type = nalType(nal)
    if (type === 7 && !sps) sps = nal
    if (type === 8 && !pps) pps = nal
    if (sps && pps) break
  }

  return { sps, pps }
}

export function buildAvcC(sps: Uint8Array, pps: Uint8Array) {
  const profile = sps[1]
  const compatibility = sps[2]
  const level = sps[3]

  const avcc = new Uint8Array(11 + sps.length + pps.length)
  let offset = 0
  avcc[offset++] = 1
  avcc[offset++] = profile
  avcc[offset++] = compatibility
  avcc[offset++] = level
  avcc[offset++] = 0xfc | 3
  avcc[offset++] = 0xe0 | 1
  avcc[offset++] = (sps.length >> 8) & 0xff
  avcc[offset++] = sps.length & 0xff
  avcc.set(sps, offset)
  offset += sps.length
  avcc[offset++] = 1
  avcc[offset++] = (pps.length >> 8) & 0xff
  avcc[offset++] = pps.length & 0xff
  avcc.set(pps, offset)
  return avcc
}

export function avc1CodecString(sps: Uint8Array) {
  const toHex = (value: number) => value.toString(16).padStart(2, '0').toUpperCase()
  return `avc1.${toHex(sps[1])}${toHex(sps[2])}${toHex(sps[3])}`
}

export function annexBFromNal(nal: Uint8Array) {
  const prefixed = new Uint8Array(nal.length + 4)
  prefixed[0] = 0
  prefixed[1] = 0
  prefixed[2] = 0
  prefixed[3] = 1
  prefixed.set(nal, 4)
  return prefixed
}

/** Length-prefixed NAL for WebCodecs VideoDecoder (AVCC sample format). */
export function avccFromNal(nal: Uint8Array) {
  const prefixed = new Uint8Array(4 + nal.length)
  new DataView(prefixed.buffer, prefixed.byteOffset, prefixed.byteLength).setUint32(
    0,
    nal.length,
    false,
  )
  prefixed.set(nal, 4)
  return prefixed
}

export function nalChunkType(nal: Uint8Array): 'key' | 'delta' | 'skip' {
  const type = nalType(nal)
  if (type === 7 || type === 8) return 'skip'
  if (type === 5) return 'key'
  if (type === 1) return 'delta'
  return 'skip'
}
