// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'

import { useComposerAttachments } from './use-composer-attachments'

const uploadAttachment = vi.hoisted(() => vi.fn())

vi.mock('@syrnike13/client/api/media-api', () => ({
  uploadAttachmentEffect: (
    token: string,
    file: File,
    options: {
      onProgress?: (progress: number) => void
      signal?: AbortSignal
    },
  ) =>
    Effect.tryPromise({
      try: () => uploadAttachment(token, file, options),
      catch: (cause) => cause,
    }),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('useComposerAttachments', () => {
  const createObjectURL = vi.fn<(file: File) => string>()
  const revokeObjectURL = vi.fn<(url: string) => void>()

  beforeEach(() => {
    uploadAttachment.mockReset()
    createObjectURL.mockReset()
    revokeObjectURL.mockReset()
    createObjectURL.mockImplementation(
      (file) => `blob:${file.name}`,
    )
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createObjectURL },
      revokeObjectURL: { configurable: true, value: revokeObjectURL },
    })
  })

  it('appends files and revokes an image preview when removing it', () => {
    const image = new File(['image'], 'photo.png', { type: 'image/png' })
    const document = new File(['document'], 'notes.txt', {
      type: 'text/plain',
    })
    const { result } = renderHook(() => useComposerAttachments('channel-1'))

    act(() => result.current.append([image, document]))

    expect(result.current.files).toHaveLength(2)
    expect(result.current.files.map((pending) => pending.file)).toEqual([
      image,
      document,
    ])
    expect(result.current.files[0]).toMatchObject({
      previewUrl: 'blob:photo.png',
      status: 'pending',
    })
    expect(createObjectURL).toHaveBeenCalledWith(image)

    const imageId = result.current.files[0]!.id
    act(() => result.current.remove(imageId))

    expect(result.current.files.map((pending) => pending.file)).toEqual([
      document,
    ])
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:photo.png')
  })

  it('aborts an in-flight upload when its file is removed', async () => {
    const pendingUpload = deferred<string>()
    uploadAttachment.mockReturnValueOnce(pendingUpload.promise)
    const file = new File(['document'], 'notes.txt', { type: 'text/plain' })
    const { result } = renderHook(() => useComposerAttachments('channel-1'))

    act(() => result.current.append([file]))
    const fileId = result.current.files[0]!.id
    let uploadPromise!: Promise<string[]>
    act(() => {
      uploadPromise = Effect.runPromise(result.current.uploadAll('token'))
    })
    const signal = uploadAttachment.mock.calls[0]![2].signal as AbortSignal

    act(() => result.current.remove(fileId))

    expect(signal.aborted).toBe(true)
    expect(result.current.files).toEqual([])

    pendingUpload.resolve('attachment-1')
    await expect(uploadPromise).resolves.toEqual(['attachment-1'])
    expect(result.current.files).toEqual([])
  })

  it('clears the previous channel queue, revokes previews, and aborts uploads', async () => {
    const pendingUpload = deferred<string>()
    uploadAttachment.mockReturnValueOnce(pendingUpload.promise)
    const image = new File(['image'], 'photo.png', { type: 'image/png' })
    const { result, rerender } = renderHook(
      ({ channelId }) => useComposerAttachments(channelId),
      { initialProps: { channelId: 'channel-1' } },
    )

    act(() => result.current.append([image]))
    let uploadPromise!: Promise<string[]>
    act(() => {
      uploadPromise = Effect.runPromise(result.current.uploadAll('token'))
    })
    const signal = uploadAttachment.mock.calls[0]![2].signal as AbortSignal

    rerender({ channelId: 'channel-2' })

    expect(result.current.files).toEqual([])
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:photo.png')
    expect(signal.aborted).toBe(true)

    pendingUpload.resolve('attachment-1')
    await expect(uploadPromise).resolves.toEqual(['attachment-1'])
    expect(result.current.files).toEqual([])
  })

  it('uploads files in parallel and exposes progress and successful ids', async () => {
    const firstUpload = deferred<string>()
    const secondUpload = deferred<string>()
    uploadAttachment
      .mockReturnValueOnce(firstUpload.promise)
      .mockReturnValueOnce(secondUpload.promise)
    const first = new File(['first'], 'first.txt', { type: 'text/plain' })
    const second = new File(['second'], 'second.txt', { type: 'text/plain' })
    const { result } = renderHook(() => useComposerAttachments('channel-1'))

    act(() => result.current.append([first, second]))
    let uploadPromise!: Promise<string[]>
    act(() => {
      uploadPromise = Effect.runPromise(result.current.uploadAll('token'))
    })

    expect(uploadAttachment).toHaveBeenCalledTimes(2)
    expect(result.current.files.map((pending) => pending.status)).toEqual([
      'uploading',
      'uploading',
    ])

    const firstOptions = uploadAttachment.mock.calls[0]![2]
    act(() => firstOptions.onProgress(0.45))
    expect(result.current.files[0]).toMatchObject({
      progress: 0.45,
      status: 'uploading',
    })

    await act(async () => {
      firstUpload.resolve('attachment-1')
      secondUpload.resolve('attachment-2')
      await uploadPromise
    })

    expect(result.current.files).toMatchObject([
      { attachmentId: 'attachment-1', progress: 1, status: 'uploaded' },
      { attachmentId: 'attachment-2', progress: 1, status: 'uploaded' },
    ])
    await expect(uploadPromise).resolves.toEqual([
      'attachment-1',
      'attachment-2',
    ])
  })

  it('retries only failed files after a partial upload failure', async () => {
    const uploadError = new Error('network failed')
    uploadAttachment.mockImplementation(async (_token, file: File) => {
      if (file.name === 'failed.txt') throw uploadError
      return 'attachment-success'
    })
    const successful = new File(['ok'], 'successful.txt', {
      type: 'text/plain',
    })
    const failed = new File(['no'], 'failed.txt', { type: 'text/plain' })
    const { result } = renderHook(() => useComposerAttachments('channel-1'))

    act(() => result.current.append([successful, failed]))
    await act(async () => {
      await expect(
        Effect.runPromise(result.current.uploadAll('token')),
      ).rejects.toBe(uploadError)
    })

    expect(result.current.files).toMatchObject([
      { attachmentId: 'attachment-success', status: 'uploaded' },
      { error: 'network failed', status: 'error' },
    ])

    uploadAttachment.mockResolvedValueOnce('attachment-retried')
    let retryResult!: string[]
    await act(async () => {
      retryResult = await Effect.runPromise(
        result.current.uploadAll('token'),
      )
    })

    expect(retryResult).toEqual([
      'attachment-success',
      'attachment-retried',
    ])
    expect(uploadAttachment).toHaveBeenCalledTimes(3)
    expect(
      uploadAttachment.mock.calls.map((call) => (call[1] as File).name),
    ).toEqual(['successful.txt', 'failed.txt', 'failed.txt'])
    await waitFor(() => {
      expect(result.current.files[1]).toMatchObject({
        attachmentId: 'attachment-retried',
        error: undefined,
        progress: 1,
        status: 'uploaded',
      })
    })
  })
})

describe('useComposerAttachments early uploads', () => {
  beforeEach(() => {
    uploadAttachment.mockReset()
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: vi.fn(() => 'blob:x') },
      revokeObjectURL: { configurable: true, value: vi.fn() },
    })
  })

  it('reuses an upload started by start() instead of uploading again', async () => {
    const upload = deferred<string>()
    uploadAttachment.mockReturnValueOnce(upload.promise)
    const { result } = renderHook(() =>
      useComposerAttachments(undefined, { tag: 'feedback' }),
    )

    act(() => result.current.append([new File(['video'], 'clip.mp4')]))
    act(() => result.current.start('token'))
    expect(uploadAttachment).toHaveBeenCalledTimes(1)
    expect(uploadAttachment.mock.calls[0]![2]).toMatchObject({ tag: 'feedback' })

    let ids: string[] = []
    const submit = Effect.runPromise(result.current.uploadAll('token')).then(
      (value) => {
        ids = value
      },
    )
    await act(async () => {
      upload.resolve('attachment-1')
      await submit
    })

    expect(ids).toEqual(['attachment-1'])
    expect(uploadAttachment).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(result.current.files[0]).toMatchObject({ status: 'uploaded' }),
    )
  })
})
