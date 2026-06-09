import { describe, expect, it } from 'vitest'

import {
  dbToRms,
  gateDbToPosition,
  normalizeVoiceGateThresholdDb,
  positionToGateDb,
  rmsToDb,
} from './voice-gate-level'
import { normalizeVoiceGateThreshold, voiceGateOpenDb } from './voice-gate'

describe('voiceGateOpenDb', () => {
  it('is always open when gate is disabled', () => {
    expect(voiceGateOpenDb(-40, -28, false)).toBe(true)
  })

  it('opens when input level is at or above threshold', () => {
    expect(voiceGateOpenDb(-28, -28, true)).toBe(true)
    expect(voiceGateOpenDb(-29, -28, true)).toBe(false)
  })
})

describe('normalizeVoiceGateThreshold', () => {
  it('clamps legacy linear thresholds', () => {
    expect(normalizeVoiceGateThreshold(2)).toBe(1)
    expect(normalizeVoiceGateThreshold(-1)).toBe(0)
  })
})

describe('voice gate dB helpers', () => {
  it('converts between rms and dB', () => {
    const db = -28
    expect(rmsToDb(dbToRms(db))).toBeCloseTo(db, 1)
  })

  it('maps dB to bar positions', () => {
    expect(gateDbToPosition(-60)).toBe(0)
    expect(gateDbToPosition(0)).toBe(1)
    expect(positionToGateDb(gateDbToPosition(-18))).toBe(-18)
  })

  it('normalizes threshold dB', () => {
    expect(normalizeVoiceGateThresholdDb(-120)).toBe(-60)
    expect(normalizeVoiceGateThresholdDb(12)).toBe(0)
  })
})
