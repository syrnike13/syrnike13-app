import type { SyrnikeDesktopApi } from '@syrnike13/platform'

const SAMPLE_RATE = 48_000

export type NativeAudioBridgeHandle = {
  track: MediaStreamTrack
  stop: () => void
}

function waitForQueueData(queue: Uint8Array[], shouldContinue: () => boolean) {
  return new Promise<void>((resolve) => {
    const tick = () => {
      if (queue.length > 0 || !shouldContinue()) {
        resolve()
        return
      }
      globalThis.setTimeout(tick, 5)
    }
    tick()
  })
}

export async function createNativeScreenShareAudioTrack(
  desktop: SyrnikeDesktopApi,
  sessionId: string,
): Promise<NativeAudioBridgeHandle> {
  return createNativeAudioTrack(desktop, sessionId, {
    sampleRate: SAMPLE_RATE,
    channels: 2,
  })
}

export async function createNativeAudioTrack(
  desktop: SyrnikeDesktopApi,
  sessionId: string,
  options: {
    sampleRate: number
    channels: 1 | 2
  },
): Promise<NativeAudioBridgeHandle> {
  if (typeof MediaStreamTrackGenerator === 'undefined') {
    throw new Error('MediaStreamTrackGenerator is not supported')
  }
  if (typeof AudioData === 'undefined') {
    throw new Error('WebCodecs audio bridge is not supported')
  }

  const generator = new MediaStreamTrackGenerator({ kind: 'audio' })
  const writer = generator.writable.getWriter()

  const packetQueue: Uint8Array[] = []
  let ended = false
  let bridgeError: Error | null = null
  let timestampUs = 0
  let writerClosed = false

  const closeWriter = () => {
    if (writerClosed) return
    writerClosed = true
    void writer.close().catch(() => {
      // Track shutdown is best-effort; the native session is already ending.
    })
  }

  const unsubscribeChunk = desktop.media.onStreamAudioChunk((event) => {
    if (event.sessionId !== sessionId) return
    packetQueue.push(new Uint8Array(event.chunk))
  })

  const unsubscribeEnded = desktop.media.onStreamEnded((id) => {
    if (id === sessionId) ended = true
  })

  const unsubscribeError = desktop.media.onStreamError((event) => {
    if (event.sessionId !== sessionId) return
    bridgeError = new Error(event.message)
  })

  const pump = async () => {
    try {
      while (!ended && !bridgeError) {
        await waitForQueueData(packetQueue, () => !ended && !bridgeError)
        if (ended || bridgeError) break

        const packet = packetQueue.shift()
        if (!packet) continue

        // Main already strips TCP length prefix; each IPC chunk is one PCM packet.
        if (packet.byteLength < options.channels * 4) continue

        const interleaved = new Float32Array(
          packet.buffer,
          packet.byteOffset,
          Math.floor(packet.byteLength / 4),
        )
        const frames = Math.floor(interleaved.length / options.channels)
        if (frames === 0) continue

        try {
          const audioData = new AudioData({
            format: 'f32',
            sampleRate: options.sampleRate,
            numberOfFrames: frames,
            numberOfChannels: options.channels,
            timestamp: timestampUs,
            data: interleaved,
          })

          await writer.write(audioData)
          audioData.close()
          timestampUs += Math.round((frames / options.sampleRate) * 1_000_000)
        } catch (error) {
          bridgeError =
            error instanceof Error ? error : new Error(String(error))
          break
        }
      }
    } finally {
      closeWriter()
    }
  }

  void pump().catch(() => {
    ended = true
  })

  const stop = () => {
    ended = true
    unsubscribeChunk()
    unsubscribeEnded()
    unsubscribeError()
    closeWriter()
  }

  return {
    track: generator,
    stop,
  }
}
