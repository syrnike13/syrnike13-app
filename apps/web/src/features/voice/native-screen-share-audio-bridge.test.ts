import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createNativeAudioTrack } from './native-screen-share-audio-bridge'

describe('createNativeAudioTrack', () => {
  const originalGenerator = globalThis.MediaStreamTrackGenerator
  const originalAudioData = globalThis.AudioData

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.MediaStreamTrackGenerator = originalGenerator
    globalThis.AudioData = originalAudioData
  })

  it('closes the generated audio writer when the native session ends without queued audio', async () => {
    const close = vi.fn(async () => {})
    const getWriter = vi.fn(() => ({
      write: vi.fn(async () => {}),
      close,
    }))
    let onEnded: ((sessionId: string) => void) | undefined

    globalThis.MediaStreamTrackGenerator = vi.fn(function MediaStreamTrackGenerator() {
      return {
        writable: {
          getWriter,
        },
      }
    }) as unknown as typeof MediaStreamTrackGenerator
    globalThis.AudioData = vi.fn() as unknown as typeof AudioData

    await createNativeAudioTrack(
      {
        media: {
          onStreamAudioChunk: vi.fn(() => vi.fn()),
          onStreamEnded: vi.fn((handler) => {
            onEnded = handler
            return vi.fn()
          }),
          onStreamError: vi.fn(() => vi.fn()),
        },
      } as never,
      'native-mic-1',
      {
        sampleRate: 48_000,
        channels: 1,
      },
    )

    onEnded?.('native-mic-1')
    await vi.advanceTimersByTimeAsync(5)

    expect(close).toHaveBeenCalledOnce()
  })

  it('drops old packets instead of growing latency when the writer is backpressured', async () => {
    const writes: AudioData[] = []
    let releaseWrite: (() => void) | undefined
    const firstWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    const write = vi
      .fn()
      .mockImplementationOnce(async (data: AudioData) => {
        writes.push(data)
        await firstWrite
      })
      .mockImplementation(async (data: AudioData) => {
        writes.push(data)
      })
    const close = vi.fn(async () => {})
    const getWriter = vi.fn(() => ({
      write,
      close,
    }))
    let onChunk: ((event: { sessionId: string; chunk: ArrayBuffer }) => void) | undefined

    globalThis.MediaStreamTrackGenerator = vi.fn(function MediaStreamTrackGenerator() {
      return {
        writable: {
          getWriter,
        },
      }
    }) as unknown as typeof MediaStreamTrackGenerator
    globalThis.AudioData = vi.fn(function AudioData() {
      return { close: vi.fn() }
    }) as unknown as typeof AudioData

    await createNativeAudioTrack(
      {
        media: {
          onStreamAudioChunk: vi.fn((handler) => {
            onChunk = handler
            return vi.fn()
          }),
          onStreamEnded: vi.fn(() => vi.fn()),
          onStreamError: vi.fn(() => vi.fn()),
        },
      } as never,
      'native-mic-1',
      {
        sampleRate: 48_000,
        channels: 1,
      },
    )

    for (let index = 0; index < 10; index += 1) {
      onChunk?.({
        sessionId: 'native-mic-1',
        chunk: new Float32Array([index]).buffer,
      })
    }
    await vi.advanceTimersByTimeAsync(5)
    releaseWrite?.()
    await vi.advanceTimersByTimeAsync(5)

    expect(write).toHaveBeenCalledTimes(6)
    expect(writes).toHaveLength(6)
  })
})
