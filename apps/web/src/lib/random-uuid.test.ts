// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { randomUuid } from '#/lib/random-uuid'

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('randomUuid', () => {
  const originalRandomUuid = globalThis.crypto?.randomUUID

  afterEach(() => {
    vi.unstubAllGlobals()
    if (originalRandomUuid) {
      Object.defineProperty(globalThis.crypto, 'randomUUID', {
        configurable: true,
        value: originalRandomUuid,
      })
    }
  })

  it('returns a v4 uuid with the native implementation', () => {
    expect(randomUuid()).toMatch(UUID_V4)
  })

  it('falls back to getRandomValues outside secure contexts', () => {
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: undefined,
    })

    const first = randomUuid()
    const second = randomUuid()

    expect(first).toMatch(UUID_V4)
    expect(second).toMatch(UUID_V4)
    expect(first).not.toBe(second)
  })

  it('still produces a uuid when crypto is missing entirely', () => {
    vi.stubGlobal('crypto', undefined)

    expect(randomUuid()).toMatch(UUID_V4)
  })
})
