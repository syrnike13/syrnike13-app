/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'

import { rnnoiseWorkletBaseUrl } from './voice-rnnoise-assets'

describe('rnnoiseWorkletBaseUrl', () => {
  it('resolves vendored assets to an absolute base URL', () => {
    const url = rnnoiseWorkletBaseUrl()

    expect(url).toMatch(/^https?:\/\//)
    expect(url).toMatch(/\/rnnoise\/$/)
  })
})
