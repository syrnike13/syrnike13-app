import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const voiceComponentFiles = [
  'voice-stage-view.tsx',
  'voice-stage-popout.tsx',
  'voice-stage-video.tsx',
]

describe('voice debug instrumentation', () => {
  it('does not ship local ingest probes in voice stage components', () => {
    for (const file of voiceComponentFiles) {
      const source = readFileSync(
        resolve(import.meta.dirname, file),
        'utf8',
      )

      expect(source).not.toContain('127.0.0.1:37887')
      expect(source).not.toContain('#region debug log')
    }
  })
})
