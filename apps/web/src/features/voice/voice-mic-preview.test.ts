import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

describe('native microphone denoise boundary', () => {
  it('does not reference RNNoise from the web voice package', () => {
    const repoRoot = resolve(
      fileURLToPath(new URL('../../../../..', import.meta.url)),
    )
    const files = [
      'apps/web/package.json',
      'apps/web/vite.config.ts',
      'apps/web/src/features/voice/voice-mic-processor.ts',
      'apps/web/src/features/voice/native-microphone-publish.ts',
      'apps/web/src/features/voice/voice-provider.tsx',
    ]

    for (const file of files) {
      const source = readFileSync(resolve(repoRoot, file), 'utf8')
      expect(source.toLowerCase()).not.toContain('rnnoise')
    }
  })
})
