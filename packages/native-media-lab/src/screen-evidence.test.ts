import { describe, expect, it } from 'vitest'
import { screenEvidenceAccepted, videoContentChanged } from './screen-evidence.js'

describe('animated screen fixture evidence', () => {
  it('ignores compression noise on frozen content', () => {
    expect(videoContentChanged(Array(64).fill(80), Array(64).fill(84))).toBe(false)
    expect(videoContentChanged(Array(64).fill(80), Array(64).fill(120))).toBe(true)
  })
  it('rejects frozen content even when fresh markers and resize arrive', () => {
    expect(screenEvidenceAccepted(0, 2, 3, 1)).toBe(false)
  })
  it('requires the resize scenario to observe an actual transition', () => {
    expect(screenEvidenceAccepted(80, 0, 3, 1)).toBe(false)
    expect(screenEvidenceAccepted(80, 1, 3, 1)).toBe(true)
  })
  it('allows static content when a scenario does not request movement', () => {
    expect(screenEvidenceAccepted(0, 0, 0, 0)).toBe(true)
  })
})
