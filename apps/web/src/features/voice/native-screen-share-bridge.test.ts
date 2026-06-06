import { describe, expect, it } from 'vitest'

import {
  annexBFromNal,
  avc1CodecString,
  avccFromNal,
  buildAvcC,
  extractSpsPps,
  isH264KeyFrameNal,
  nalType,
  parseH264Nals,
  splitAnnexB,
  splitAvcc,
} from '#/features/voice/h264-avcc'

const SPS = new Uint8Array([0x67, 0x42, 0xe0, 0x1e, 0x8d, 0x68])
const PPS = new Uint8Array([0x68, 0xce, 0x3c, 0x80])
const IDR = new Uint8Array([0x65, 0x88, 0x84])

describe('h264 annex-b parser', () => {
  it('splits 4-byte start codes', () => {
    const buffer = new Uint8Array([
      ...annexBFromNal(SPS),
      ...annexBFromNal(PPS),
      ...annexBFromNal(IDR),
    ])
    const units = splitAnnexB(buffer)
    expect(units).toHaveLength(3)
    expect(nalType(units[0]!)).toBe(7)
    expect(nalType(units[1]!)).toBe(8)
    expect(nalType(units[2]!)).toBe(5)
  })

  it('extracts sps/pps and builds avcC', () => {
    const buffer = new Uint8Array([...annexBFromNal(SPS), ...annexBFromNal(PPS)])
    const { sps, pps } = extractSpsPps(splitAnnexB(buffer))
    expect(sps).not.toBeNull()
    expect(pps).not.toBeNull()

    const avcc = buildAvcC(sps!, pps!)
    expect(avcc[0]).toBe(1)
    expect(avcc[1]).toBe(SPS[1])
    expect(avc1CodecString(sps!)).toBe('avc1.42E01E')
  })

  it('detects keyframe nals', () => {
    expect(isH264KeyFrameNal(SPS)).toBe(true)
    expect(isH264KeyFrameNal(PPS)).toBe(true)
    expect(isH264KeyFrameNal(IDR)).toBe(true)
    expect(isH264KeyFrameNal(new Uint8Array([0x41]))).toBe(false)
  })

  it('parses avcc samples and mf-style prefixed avcc', () => {
    const avcc = new Uint8Array([
      ...avccFromNal(SPS),
      ...avccFromNal(PPS),
      ...avccFromNal(IDR),
    ])
    const avccNals = splitAvcc(avcc)
    expect(avccNals).toHaveLength(3)
    expect(nalType(avccNals[0]!)).toBe(7)

    const mfSample = new Uint8Array([0, 0, 0, 1, ...avcc])
    const parsed = parseH264Nals(mfSample)
    expect(parsed).toHaveLength(3)
    expect(nalType(parsed[2]!)).toBe(5)
  })
})
