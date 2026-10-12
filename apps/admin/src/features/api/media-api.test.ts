// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { uploadMediaFile } from './media-api'

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
  abort = vi.fn()
  open = vi.fn()
  send = vi.fn()
  setRequestHeader = vi.fn()

  constructor() {
    super()
    MockXMLHttpRequest.latest = this
  }
}

describe('uploadMediaFile', () => {
  beforeEach(() => {
    vi.stubGlobal('XMLHttpRequest', MockXMLHttpRequest)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('decodes a successful upload response', async () => {
    const promise = uploadMediaFile(
      'session-token',
      'avatars',
      new File(['data'], 'avatar.png'),
    )
    const xhr = MockXMLHttpRequest.latest
    xhr.readyState = 4
    xhr.status = 201
    xhr.response = { id: 'media-id' }
    xhr.dispatchEvent(new Event('loadend'))

    await expect(promise).resolves.toBe('media-id')
    expect(xhr.open).toHaveBeenCalledWith(
      'POST',
      'https://media.example.test/avatars',
      true,
    )
    expect(xhr.setRequestHeader).toHaveBeenCalledWith(
      'X-Session-Token',
      'session-token',
    )
  })

  it('rejects an invalid successful response', async () => {
    const promise = uploadMediaFile(
      'session-token',
      'badges',
      new File(['data'], 'badge.png'),
    )
    const xhr = MockXMLHttpRequest.latest
    xhr.readyState = 4
    xhr.status = 200
    xhr.response = { id: '' }
    xhr.dispatchEvent(new Event('loadend'))

    await expect(promise).rejects.toThrow('Не удалось загрузить файл')
  })

  it('rejects network failures distinctly', async () => {
    const promise = uploadMediaFile(
      'session-token',
      'backgrounds',
      new File(['data'], 'background.png'),
    )

    MockXMLHttpRequest.latest.dispatchEvent(new Event('error'))

    await expect(promise).rejects.toThrow('Ошибка сети при загрузке')
  })

  it('reports upload progress', () => {
    const onProgress = vi.fn()
    void uploadMediaFile(
      'session-token',
      'avatars',
      new File(['data'], 'avatar.png'),
      onProgress,
    )

    MockXMLHttpRequest.latest.upload.dispatchEvent(
      Object.assign(new Event('progress'), {
        lengthComputable: true,
        loaded: 3,
        total: 4,
      }),
    )

    expect(onProgress).toHaveBeenCalledWith(0.75)
  })
})
