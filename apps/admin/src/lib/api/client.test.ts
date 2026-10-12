import { afterEach, describe, expect, it, vi } from 'vitest'
import { Schema } from 'effect'

vi.mock('#/lib/config', () => ({
  config: {
    apiUrl: 'https://api.example.test',
  },
}))

import { ApiError, ApiNetworkError, apiRequest } from './client'

describe('apiRequest', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('classifies fetch failures as network errors', async () => {
    const cause = new TypeError('Failed to fetch')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw cause
      }),
    )

    await expect(apiRequest('/users/@me', Schema.Unknown)).rejects.toMatchObject({
      name: 'ApiNetworkError',
      cause,
    })
    await expect(apiRequest('/users/@me', Schema.Unknown)).rejects.toBeInstanceOf(
      ApiNetworkError,
    )
  })

  it('decodes successful JSON responses with the supplied schema', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ id: 'user-1', admin: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )

    await expect(
      apiRequest(
        '/users/user-1',
        Schema.Struct({
          id: Schema.String,
          admin: Schema.Boolean,
        }),
      ),
    ).resolves.toEqual({ id: 'user-1', admin: true })
  })

  it('maps invalid successful responses to ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ id: 42 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )

    await expect(
      apiRequest('/users/user-1', Schema.Struct({ id: Schema.String })),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 200,
      message: 'API вернул ответ, не соответствующий контракту',
    })
  })

  it('accepts empty successful responses with Schema.Void', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    )

    await expect(apiRequest('/auth/session/logout', Schema.Void)).resolves.toBe(
      undefined,
    )
  })

  it('does not leak JSON parser errors for malformed successful responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('{invalid-json', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )

    const request = apiRequest(
      '/users/user-1',
      Schema.Struct({ id: Schema.String }),
    )

    await expect(request).rejects.toBeInstanceOf(ApiError)
    await expect(request).rejects.not.toBeInstanceOf(SyntaxError)
  })

  it('interrupts the request when the caller aborts', async () => {
    const controller = new AbortController()
    let fetchSignal: AbortSignal | null | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            fetchSignal = init?.signal
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            )
          }),
      ),
    )

    const request = apiRequest('/users/@me', Schema.Unknown, {
      signal: controller.signal,
    })
    await vi.waitFor(() => {
      expect(fetchSignal).toBeDefined()
    })

    controller.abort()

    await expect(request).rejects.toBeDefined()
    expect(fetchSignal?.aborted).toBe(true)
  })
})
