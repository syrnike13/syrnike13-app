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
})
