import { describe, expect, it } from 'vitest'

import { meterLevelsFromRms, MIC_PREVIEW_METER_BAR_COUNT } from './voice-mic-preview'

describe('meterLevelsFromRms', () => {
  it('returns higher bars for louder input', () => {
    const quiet = meterLevelsFromRms(0.01, MIC_PREVIEW_METER_BAR_COUNT)
    const loud = meterLevelsFromRms(0.2, MIC_PREVIEW_METER_BAR_COUNT)

    const quietAvg = quiet.reduce((sum, value) => sum + value, 0) / quiet.length
    const loudAvg = loud.reduce((sum, value) => sum + value, 0) / loud.length

    expect(loudAvg).toBeGreaterThan(quietAvg)
  })
})
