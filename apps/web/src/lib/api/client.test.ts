import { afterEach, describe, expect, it, vi } from 'vitest'
import { Schema } from 'effect'

vi.mock('#/lib/config', () => ({
  config: {
    apiUrl: 'https://api.example.test',
  },
}))

import { ApiError, ApiNetworkError, apiBlobRequest, apiRequest } from './client'

describe('apiRequest', () => {
  it('classifies image-body read failures without losing their cause', async () => {
    const cause = new Error('image body interrupted')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const response = new Response(null)
        vi.spyOn(response, 'blob').mockRejectedValue(cause)
        return response
      }),
    )
    await expect(apiBlobRequest('/preview')).rejects.toMatchObject({
      name: 'ApiNetworkError',
      message: 'Не удалось прочитать ответ API',
      cause,
    })
  })

  it('keeps cancellation attached while an image response body is still loading', async () => {
    let requestSignal: AbortSignal | null | undefined
    let body: ReadableStreamDefaultController<Uint8Array> | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        body = controller
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, options: RequestInit) => {
        requestSignal = options.signal
        options.signal?.addEventListener('abort', () =>
          body?.error(new DOMException('Aborted', 'AbortError')),
        )
        return new Response(stream, {
          headers: { 'Content-Type': 'image/webp' },
        })
      }),
    )
    const controller = new AbortController()
    const request = apiBlobRequest('/preview', { signal: controller.signal })
    await vi.waitFor(() => expect(requestSignal).toBeTruthy())
    controller.abort()
    await expect(request).rejects.toBeDefined()
    expect(requestSignal?.aborted).toBe(true)
  })

  it('uploads an image as raw authenticated bytes rather than JSON', async () => {
    const image = new Blob(['image bytes'], { type: 'image/webp' })
    const fetchMock = vi.fn(
      async (_url: string, _options: RequestInit) =>
        new Response(null, { status: 204 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await apiRequest('/channels/voice/voice/stream-preview', Schema.Void, {
      method: 'PUT',
      token: 'session',
      body: image,
    })
    const options = fetchMock.mock.calls[0][1]
    expect(options.body).toBe(image)
    const headers = new Headers(options.headers)
    expect(headers.get('Content-Type')).toBe('image/webp')
    expect(headers.get('X-Session-Token')).toBe('session')
  })

  it('fetches binary previews and treats a missing preview as an empty state', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('image bytes', {
          headers: { 'Content-Type': 'image/webp' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const image = await apiBlobRequest('/preview', { token: 'session' })
    expect(image?.type).toBe('image/webp')
    expect(await image?.text()).toBe('image bytes')
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }))
    expect(await apiBlobRequest('/preview')).toBeNull()
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }))
    await expect(apiBlobRequest('/preview')).rejects.toBeInstanceOf(ApiError)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('classifies fetch failures as network errors', async () => {
    const cause = new TypeError('Failed to fetch')
    const fetchMock = vi.fn(async () => {
      throw cause
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(apiRequest('/users/@me', Schema.Unknown)).rejects.toBeInstanceOf(
      ApiNetworkError,
    )
    await expect(apiRequest('/users/@me', Schema.Unknown)).rejects.toMatchObject({
      name: 'ApiNetworkError',
      cause,
    })
  })

  it('decodes successful JSON responses with the supplied schema', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ id: 'user-1', online: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )

    const result = await apiRequest(
      '/users/user-1',
      Schema.Struct({
        id: Schema.String,
        online: Schema.Boolean,
      }),
    )

    expect(result).toEqual({ id: 'user-1', online: true })
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

    await expect(apiRequest('/sessions/current', Schema.Void)).resolves.toBe(
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
