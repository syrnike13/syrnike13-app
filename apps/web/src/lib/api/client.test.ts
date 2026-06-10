import { describe, expect, it, vi } from 'vitest'

vi.mock('#/lib/config', () => ({
  config: {
    apiUrl: 'https://api.example.test',
  },
}))

import { ApiNetworkError, apiRequest } from './client'

describe('apiRequest', () => {
  it('classifies fetch failures as network errors', async () => {
    const cause = new TypeError('Failed to fetch')
    const fetchMock = vi.fn(async () => {
      throw cause
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(apiRequest('/users/@me')).rejects.toBeInstanceOf(
      ApiNetworkError,
    )
    await expect(apiRequest('/users/@me')).rejects.toMatchObject({
      name: 'ApiNetworkError',
      cause,
    })
  })
})
