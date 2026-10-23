import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTranslator } from '@syrnike13/ui/i18n'

import ru from '#/messages/ru.json'
import {
  scheduleStreamPreview,
  captureStreamPreview,
  streamPreviewDimensions,
  streamPreviewWatchLabel,
} from './stream-preview'
import { NativeVideoRegistry } from './native-video-registry'

const t = createTranslator(ru, 'ru', 'voice')

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function captureFixture() {
  const drawImage = vi.fn()
  const encode = vi.fn((resolve: (image: Blob) => void, type: string) => {
    resolve(new Blob(['preview'], { type }))
  })
  const canvases = Array.from({ length: 2 }, () => ({
    width: 0,
    height: 0,
    getContext: () => ({ drawImage }),
    toBlob: encode,
  }))
  let index = 0
  vi.stubGlobal('document', { createElement: () => canvases[index++] })
  const adapter = new NativeVideoRegistry().getLocalScreenPreviewTrack()
  let frameReady = () => {}
  const detach = vi.fn()
  const attach = vi
    .spyOn(adapter, 'attachCanvas')
    .mockImplementation((canvas, _size, options) => {
      frameReady = () => {
        canvas.width = 480
        canvas.height = 270
        options?.onFrame?.()
      }
      return detach
    })
  return {
    adapter,
    attach,
    detach,
    encode,
    drawImage,
    canvases,
    frame: () => frameReady(),
  }
}

describe('per-capture attachment', () => {
  it('attaches only when due, then detaches before encoding and throughout the interval', async () => {
    vi.useFakeTimers()
    const fixture = captureFixture()
    const abort = new AbortController()
    const capture = vi.fn(async () => {
      await captureStreamPreview(
        { backend: 'native', track: fixture.adapter },
        abort.signal,
      )
    })
    fixture.encode.mockImplementation((resolve, type) => {
      expect(fixture.detach).toHaveBeenCalledOnce()
      resolve(new Blob(['preview'], { type }))
    })
    const schedule = scheduleStreamPreview(capture, vi.fn())
    schedule.start()
    await vi.advanceTimersByTimeAsync(2_999)
    expect(fixture.attach).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fixture.attach).toHaveBeenCalledOnce()
    expect(fixture.detach).not.toHaveBeenCalled()
    fixture.frame()
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.drawImage).toHaveBeenCalledOnce()
    expect(fixture.detach).toHaveBeenCalledOnce()
    expect(
      fixture.canvases.every(
        (canvas) => canvas.width === 0 && canvas.height === 0,
      ),
    ).toBe(true)
    await vi.advanceTimersByTimeAsync(119_999)
    expect(capture).toHaveBeenCalledOnce()
    schedule.stop()
  })

  it('reports a five-second first-frame timeout and detaches without an early retry', async () => {
    vi.useFakeTimers()
    const fixture = captureFixture()
    const report = vi.fn()
    const schedule = scheduleStreamPreview(async () => {
      await captureStreamPreview(
        { backend: 'native', track: fixture.adapter },
        new AbortController().signal,
      )
    }, report)
    schedule.start()
    await vi.advanceTimersByTimeAsync(8_000)
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('timed out'),
      }),
    )
    expect(fixture.detach).toHaveBeenCalledOnce()
    expect(fixture.encode).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(119_999)
    expect(fixture.attach).toHaveBeenCalledOnce()
    schedule.stop()
  })

  it('detaches immediately when a pending first frame is cancelled', async () => {
    vi.useFakeTimers()
    const fixture = captureFixture()
    const abort = new AbortController()
    const pending = captureStreamPreview(
      { backend: 'native', track: fixture.adapter },
      abort.signal,
    )
    const rejected = expect(pending).rejects.toMatchObject({
      name: 'AbortError',
    })
    abort.abort()
    await rejected
    expect(fixture.detach).toHaveBeenCalledOnce()
    expect(fixture.encode).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('stream preview capture schedule', () => {
  it('captures three seconds after track availability and every two minutes', async () => {
    vi.useFakeTimers()
    const capture = vi.fn(async () => {})
    const schedule = scheduleStreamPreview(capture, vi.fn())
    await vi.advanceTimersByTimeAsync(120_000)
    expect(capture).not.toHaveBeenCalled()
    schedule.start()
    schedule.start()
    await vi.advanceTimersByTimeAsync(2_999)
    expect(capture).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(capture).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(capture).toHaveBeenCalledTimes(2)
    schedule.stop()
    await vi.advanceTimersByTimeAsync(240_000)
    expect(capture).toHaveBeenCalledTimes(2)
  })

  it('cancels the initial timer on stream end and cannot restart', async () => {
    vi.useFakeTimers()
    const capture = vi.fn(async () => {})
    const schedule = scheduleStreamPreview(capture, vi.fn())
    schedule.start()
    schedule.stop()
    schedule.start()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(capture).not.toHaveBeenCalled()
  })

  it('reports failure once per interval without overlapping captures', async () => {
    vi.useFakeTimers()
    const error = new Error('upload failed')
    const capture = vi.fn(async () => {
      throw error
    })
    const report = vi.fn()
    const schedule = scheduleStreamPreview(capture, report)
    schedule.start()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(report).toHaveBeenCalledWith(error)
    await vi.advanceTimersByTimeAsync(119_999)
    expect(capture).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(capture).toHaveBeenCalledTimes(2)
    schedule.stop()
  })

  it('does not reschedule after a pending capture finishes following stop', async () => {
    vi.useFakeTimers()
    let finish = () => {}
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const capture = vi.fn(() => pending)
    const schedule = scheduleStreamPreview(capture, vi.fn())
    schedule.start()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(capture).toHaveBeenCalledTimes(1)
    schedule.stop()
    finish()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(capture).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})

it('downscales within 480x270 while preserving the source aspect ratio', () => {
  expect(streamPreviewDimensions(1920, 1080)).toEqual({
    width: 480,
    height: 270,
  })
  expect(streamPreviewDimensions(1080, 1920)).toEqual({
    width: 152,
    height: 270,
  })
  expect(streamPreviewDimensions(2560, 1080)).toEqual({
    width: 480,
    height: 203,
  })
  expect(streamPreviewDimensions(100, 50)).toEqual({ width: 100, height: 50 })
})

it('prioritizes self and already-watching labels', () => {
  expect(streamPreviewWatchLabel(true, true, t)).toBe('Вы стримите!')
  expect(streamPreviewWatchLabel(false, true, t)).toBe('Вы смотрите')
  expect(streamPreviewWatchLabel(false, false, t)).toBe('Смотреть стрим')
})
