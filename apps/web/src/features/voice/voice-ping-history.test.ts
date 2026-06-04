import { describe, expect, it } from 'vitest'

import {
  appendVoicePingSample,
  summarizeVoicePingHistory,
  VOICE_PING_HISTORY_MAX,
  voicePingChartDomain,
} from '#/features/voice/voice-ping-history'

describe('voicePingHistory', () => {
  it('caps history length', () => {
    let history: ReturnType<typeof appendVoicePingSample> = []
    for (let index = 0; index < VOICE_PING_HISTORY_MAX + 5; index++) {
      history = appendVoicePingSample(history, {
        timestamp: index,
        ms: 50 + index,
      })
    }
    expect(history).toHaveLength(VOICE_PING_HISTORY_MAX)
    expect(history[0]?.ms).toBe(55)
  })

  it('summarizes average and last ping', () => {
    const summary = summarizeVoicePingHistory([
      { timestamp: 1, ms: 100 },
      { timestamp: 2, ms: 200 },
    ])
    expect(summary.averageMs).toBe(150)
    expect(summary.lastMs).toBe(200)
  })

  it('zooms Y axis around stable low ping', () => {
    const domain = voicePingChartDomain([
      { timestamp: 1, ms: 98 },
      { timestamp: 2, ms: 102 },
      { timestamp: 3, ms: 100 },
    ])
    expect(domain.yMax - domain.yMin).toBeLessThan(80)
    expect(domain.yMin).toBeLessThan(98)
    expect(domain.yMax).toBeGreaterThan(102)
  })

  it('expands Y axis for large spikes', () => {
    const domain = voicePingChartDomain([
      { timestamp: 1, ms: 90 },
      { timestamp: 2, ms: 420 },
    ])
    expect(domain.yMax).toBeGreaterThanOrEqual(420)
  })
})
