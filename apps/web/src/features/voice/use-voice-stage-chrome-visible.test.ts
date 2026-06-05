import { describe, expect, it } from 'vitest'

import { voiceStageChromeMotion } from '#/features/voice/use-voice-stage-chrome-visible'

describe('voiceStageChromeMotion', () => {
  it('slides header up and fades out when hidden', () => {
    expect(voiceStageChromeMotion(false, 'top')).toContain('-translate-y-full')
    expect(voiceStageChromeMotion(false, 'top')).toContain('opacity-0')
    expect(voiceStageChromeMotion(true, 'top')).toContain('translate-y-0')
    expect(voiceStageChromeMotion(true, 'top')).toContain('opacity-100')
  })

  it('slides controls down and fades out when hidden', () => {
    expect(voiceStageChromeMotion(false, 'bottom')).toContain('translate-y-full')
    expect(voiceStageChromeMotion(false, 'bottom')).toContain('opacity-0')
    expect(voiceStageChromeMotion(true, 'bottom')).toContain('translate-y-0')
    expect(voiceStageChromeMotion(true, 'bottom')).toContain('opacity-100')
  })
})
