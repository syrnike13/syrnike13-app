import { beforeEach, describe, expect, it, vi } from 'vitest'

import { uploadAttachment } from '#/features/api/media-api'

vi.mock('#/lib/config', () => ({
  config: { mediaUrl: 'https://media.example.test' },
}))

class MockXMLHttpRequest extends EventTarget {
  static latest: MockXMLHttpRequest

  readonly upload = new EventTarget()
  readyState = 1
  status = 0
  response: unknown = null
  responseType: XMLHttpRequestResponseType = ''
  abort = vi.fn(() => {
    this.dispatchEvent(new Event('abort'))
  })
  open = vi.fn()
  send = vi.fn()
  setRequestHeader = vi.fn()

  constructor() {
    super()
    MockXMLHttpRequest.latest = this
  }
}

describe('uploadAttachment', () => {
  beforeEach(() => {
    vi.stubGlobal('XMLHttpRequest', MockXMLHttpRequest)
  })

  it('reports clamped upload progress', () => {
    const onProgress = vi.fn()

    void uploadAttachment('session-token', new File(['data'], 'file.txt'), {
      onProgress,
    })

    MockXMLHttpRequest.latest.upload.dispatchEvent(
      Object.assign(new Event('progress'), {
        lengthComputable: true,
        loaded: 15,
        total: 10,
      }),
    )

    expect(onProgress).toHaveBeenCalledWith(1)
  })

  it('aborts the request and rejects with AbortError', async () => {
    const controller = new AbortController()
    const promise = uploadAttachment(
      'session-token',
      new File(['data'], 'file.txt'),
      { signal: controller.signal },
    )

    controller.abort()

    expect(MockXMLHttpRequest.latest.abort).toHaveBeenCalledOnce()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects network failures with a distinct error', async () => {
    const promise = uploadAttachment(
      'session-token',
      new File(['data'], 'file.txt'),
    )

    MockXMLHttpRequest.latest.dispatchEvent(new Event('error'))
    MockXMLHttpRequest.latest.dispatchEvent(new Event('load'))

    await expect(promise).rejects.toThrow('Ошибка сети при загрузке')
  })
})
