import type { SyrnikeDesktopApi } from '@syrnike13/platform'

const SAMPLE_RATE = 48_000
const NATIVE_MIC_DEBUG_STORAGE_KEY = 'syrnike.nativeMicDebug'
const MAX_AUDIO_PACKET_QUEUE = 6
const WORKLET_TARGET_BUFFER_MS = 160
const WORKLET_MAX_BUFFER_MS = 420
const AUDIO_DEBUG_SESSION_ID = '3e5d1e'

export type NativeAudioBridgeHandle = {
  track: MediaStreamTrack
  stop: () => void
}

function waitForQueueData(
  queue: Uint8Array[],
  shouldContinue: () => boolean,
  setWaiter: (notify: (() => void) | null) => void,
) {
  if (queue.length > 0 || !shouldContinue()) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    setWaiter(resolve)
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
  if (canUseNativeAudioWorklet()) {
    return createNativeAudioWorkletTrack(desktop, sessionId, options)
  }
  return createNativeAudioGeneratorTrack(desktop, sessionId, options)
}

async function createNativeAudioGeneratorTrack(
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
  let lastDebugAt = 0
  let lastAgentDebugAt = 0
  let receivedPackets = 0
  let droppedPackets = 0
  let notifyQueueData: (() => void) | null = null
  let lastPacketPerfAt = 0
  let lastWritePerfAt = 0
  let firstWritePerfAt = 0
  let cadenceLogAt = 0
  let arrivalCount = 0
  let arrivalSumMs = 0
  let arrivalMinMs = Number.POSITIVE_INFINITY
  let arrivalMaxMs = 0
  let writeCount = 0
  let writeSumMs = 0
  let writeMinMs = Number.POSITIVE_INFINITY
  let writeMaxMs = 0

  const resetCadenceWindow = () => {
    arrivalCount = 0
    arrivalSumMs = 0
    arrivalMinMs = Number.POSITIVE_INFINITY
    arrivalMaxMs = 0
    writeCount = 0
    writeSumMs = 0
    writeMinMs = Number.POSITIVE_INFINITY
    writeMaxMs = 0
  }

  const postCadenceDebug = (nowPerf: number, phase: string) => {
    if (nowPerf - cadenceLogAt <= 500) return
    cadenceLogAt = nowPerf
    const wallDurationUs =
      firstWritePerfAt > 0 ? Math.round((nowPerf - firstWritePerfAt) * 1000) : 0
    // #region agent log
    postAudioDebugLog(desktop, {
      runId: 'audio-lag-initial',
      hypothesisId: 'H6-renderer-track-generator-cadence',
      location: 'native-screen-share-audio-bridge.ts:createNativeAudioTrack',
      message: 'renderer bridge cadence window',
      data: {
        sessionId,
        phase,
        queueLength: packetQueue.length,
        receivedPackets,
        droppedPackets,
        timestampUs,
        wallDurationUs,
        mediaAheadUs: timestampUs - wallDurationUs,
        arrivalCount,
        arrivalAvgMs: arrivalCount > 0 ? arrivalSumMs / arrivalCount : null,
        arrivalMinMs: arrivalCount > 0 ? arrivalMinMs : null,
        arrivalMaxMs: arrivalCount > 0 ? arrivalMaxMs : null,
        writeCount,
        writeAvgMs: writeCount > 0 ? writeSumMs / writeCount : null,
        writeMinMs: writeCount > 0 ? writeMinMs : null,
        writeMaxMs: writeCount > 0 ? writeMaxMs : null,
      },
    })
    // #endregion
    resetCadenceWindow()
  }

  const closeWriter = () => {
    if (writerClosed) return
    writerClosed = true
    void writer.close().catch(() => {
      // Track shutdown is best-effort; the native session is already ending.
    })
  }

  const unsubscribeChunk = desktop.media.onStreamAudioChunk((event) => {
    if (event.sessionId !== sessionId) return
    const packetPerfAt = performance.now()
    if (lastPacketPerfAt > 0) {
      const deltaMs = packetPerfAt - lastPacketPerfAt
      arrivalCount += 1
      arrivalSumMs += deltaMs
      arrivalMinMs = Math.min(arrivalMinMs, deltaMs)
      arrivalMaxMs = Math.max(arrivalMaxMs, deltaMs)
    }
    lastPacketPerfAt = packetPerfAt
    packetQueue.push(new Uint8Array(event.chunk))
    const notify = notifyQueueData
    notifyQueueData = null
    notify?.()
    while (packetQueue.length > MAX_AUDIO_PACKET_QUEUE) {
      packetQueue.shift()
      droppedPackets += 1
    }
    receivedPackets += 1
    const now = Date.now()
    if (now - lastAgentDebugAt > 500) {
      lastAgentDebugAt = now
      // #region agent log
      postAudioDebugLog(desktop, {
        runId: 'audio-lag-initial',
        hypothesisId: 'H3-renderer-bridge-backpressure',
        location: 'native-screen-share-audio-bridge.ts:onStreamAudioChunk',
        message: 'renderer bridge enqueue',
        data: {
          sessionId,
          queueLength: packetQueue.length,
          packetBytes: event.chunk.byteLength,
          receivedPackets,
          droppedPackets,
          maxQueue: MAX_AUDIO_PACKET_QUEUE,
        },
      })
      // #endregion
    }
    postCadenceDebug(packetPerfAt, 'enqueue')
  })

  const unsubscribeEnded = desktop.media.onStreamEnded((id) => {
    if (id === sessionId) {
      ended = true
      const notify = notifyQueueData
      notifyQueueData = null
      notify?.()
    }
  })

  const unsubscribeError = desktop.media.onStreamError((event) => {
    if (event.sessionId !== sessionId) return
    bridgeError = new Error(event.message)
    const notify = notifyQueueData
    notifyQueueData = null
    notify?.()
  })

  const pump = async () => {
    try {
      while (!ended && !bridgeError) {
        await waitForQueueData(
          packetQueue,
          () => !ended && !bridgeError,
          (notify) => {
            notifyQueueData = notify
          },
        )
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
          const now = Date.now()
          if (isNativeMicDebugEnabled() && now - lastDebugAt > 1000) {
            lastDebugAt = now
            console.info('[native-mic-debug] renderer bridge received audio packet', {
              sessionId,
              bytes: packet.byteLength,
              frames,
              channels: options.channels,
              sampleRate: options.sampleRate,
              rms: pcmF32Rms(interleaved),
              peak: pcmF32Peak(interleaved),
            })
          }
          const audioData = new AudioData({
            format: 'f32',
            sampleRate: options.sampleRate,
            numberOfFrames: frames,
            numberOfChannels: options.channels,
            timestamp: timestampUs,
            data: interleaved,
          })

          const writeStartedAt = performance.now()
          await writer.write(audioData)
          const writeCompletedAt = performance.now()
          const writeMs = writeCompletedAt - writeStartedAt
          if (lastWritePerfAt > 0) {
            const deltaMs = writeCompletedAt - lastWritePerfAt
            writeCount += 1
            writeSumMs += deltaMs
            writeMinMs = Math.min(writeMinMs, deltaMs)
            writeMaxMs = Math.max(writeMaxMs, deltaMs)
          } else {
            firstWritePerfAt = writeCompletedAt
            cadenceLogAt = writeCompletedAt
          }
          lastWritePerfAt = writeCompletedAt
          audioData.close()
          timestampUs += Math.round((frames / options.sampleRate) * 1_000_000)
          postCadenceDebug(writeCompletedAt, 'write')
          if (writeMs > 10 || packetQueue.length > 2) {
            // #region agent log
            postAudioDebugLog(desktop, {
              runId: 'audio-lag-initial',
              hypothesisId: 'H3-renderer-bridge-backpressure',
              location: 'native-screen-share-audio-bridge.ts:writer.write',
              message: 'renderer bridge write completed',
              data: {
                sessionId,
                writeMs,
                frames,
                queueLength: packetQueue.length,
                timestampUs,
                sampleRate: options.sampleRate,
                channels: options.channels,
              },
            })
            // #endregion
          }
        } catch (error) {
          bridgeError =
            error instanceof Error ? error : new Error(String(error))
          console.error('[native-mic-debug] renderer bridge failed to write audio packet', {
            sessionId,
            message: bridgeError.message,
            bytes: packet.byteLength,
            frames,
            channels: options.channels,
            sampleRate: options.sampleRate,
          })
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
    const notify = notifyQueueData
    notifyQueueData = null
    notify?.()
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

async function createNativeAudioWorkletTrack(
  desktop: SyrnikeDesktopApi,
  sessionId: string,
  options: {
    sampleRate: number
    channels: 1 | 2
  },
): Promise<NativeAudioBridgeHandle> {
  const context = new AudioContext({ sampleRate: options.sampleRate })
  const moduleUrl = getNativePcmWorkletModuleUrl()
  // #region agent log
  postAudioDebugLog(desktop, {
    runId: 'audio-worklet-csp-fix',
    hypothesisId: 'H9-worklet-module-url-csp',
    location: 'native-screen-share-audio-bridge.ts:createNativeAudioWorkletTrack',
    message: 'AudioWorklet module load start',
    data: {
      moduleUrl,
      isBlobUrl: moduleUrl.startsWith('blob:'),
      sampleRate: options.sampleRate,
      channels: options.channels,
    },
  })
  // #endregion
  try {
    await context.audioWorklet.addModule(moduleUrl)
    // #region agent log
    postAudioDebugLog(desktop, {
      runId: 'audio-worklet-csp-fix',
      hypothesisId: 'H9-worklet-module-url-csp',
      location: 'native-screen-share-audio-bridge.ts:createNativeAudioWorkletTrack',
      message: 'AudioWorklet module load success',
      data: {
        moduleUrl,
        isBlobUrl: moduleUrl.startsWith('blob:'),
      },
    })
    // #endregion
  } catch (error) {
    // #region agent log
    postAudioDebugLog(desktop, {
      runId: 'audio-worklet-csp-fix',
      hypothesisId: 'H9-worklet-module-url-csp',
      location: 'native-screen-share-audio-bridge.ts:createNativeAudioWorkletTrack',
      message: 'AudioWorklet module load failed',
      data: {
        moduleUrl,
        isBlobUrl: moduleUrl.startsWith('blob:'),
        error: error instanceof Error ? error.message : String(error),
      },
    })
    // #endregion
    void context.close()
    throw error
  }

  const ringMode = false

  const destination = context.createMediaStreamDestination()
  const targetBufferFrames = Math.round(
    (options.sampleRate * WORKLET_TARGET_BUFFER_MS) / 1000,
  )
  const maxBufferFrames = Math.round(
    (options.sampleRate * WORKLET_MAX_BUFFER_MS) / 1000,
  )
  const worklet = new AudioWorkletNode(context, 'native-pcm-jitter-buffer', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [options.channels],
    processorOptions: {
      channels: options.channels,
      targetBufferFrames,
      maxBufferFrames,
    },
  })

  let stopped = false
  let receivedPackets = 0
  let droppedByWorklet = 0
  let underruns = 0
  let lastPacketPerfAt = 0
  let lastDebugAt = 0
  let arrivalCount = 0
  let arrivalSumMs = 0
  let arrivalMinMs = Number.POSITIVE_INFINITY
  let arrivalMaxMs = 0

  const resetArrivalWindow = () => {
    arrivalCount = 0
    arrivalSumMs = 0
    arrivalMinMs = Number.POSITIVE_INFINITY
    arrivalMaxMs = 0
  }

  worklet.port.onmessage = (message) => {
    const data = message.data as
      | {
          type: 'metrics'
          queuedFrames: number
          droppedFrames: number
          underruns: number
          started: boolean
          ringMode?: boolean
        }
      | undefined
    if (!data || data.type !== 'metrics') return
    droppedByWorklet = data.droppedFrames
    underruns = data.underruns
    const now = performance.now()
    if (now - lastDebugAt <= 500) return
    lastDebugAt = now
    // #region agent log
    postAudioDebugLog(desktop, {
      runId: ringMode ? 'audio-ring-main' : 'audio-lag-initial',
      hypothesisId: ringMode
        ? 'H10-main-process-pcm-ring'
        : 'H8-audio-worklet-jitter-buffer',
      location: 'native-screen-share-audio-bridge.ts:AudioWorklet',
      message: 'audio worklet jitter buffer metrics',
      data: {
        sessionId,
        ringMode: data.ringMode ?? ringMode,
        receivedPackets,
        queuedFrames: data.queuedFrames,
        targetBufferFrames,
        maxBufferFrames,
        droppedFrames: droppedByWorklet,
        underruns,
        started: data.started,
        arrivalCount: ringMode ? null : arrivalCount,
        arrivalAvgMs:
          !ringMode && arrivalCount > 0 ? arrivalSumMs / arrivalCount : null,
        arrivalMinMs: !ringMode && arrivalCount > 0 ? arrivalMinMs : null,
        arrivalMaxMs: !ringMode && arrivalCount > 0 ? arrivalMaxMs : null,
      },
    })
    // #endregion
    resetArrivalWindow()
  }

  worklet.connect(destination)
  await context.resume()

  const unsubscribeChunk = ringMode
    ? () => {}
    : desktop.media.onStreamAudioChunk((event) => {
        if (event.sessionId !== sessionId || stopped) return
        const packetPerfAt = performance.now()
        if (lastPacketPerfAt > 0) {
          const deltaMs = packetPerfAt - lastPacketPerfAt
          arrivalCount += 1
          arrivalSumMs += deltaMs
          arrivalMinMs = Math.min(arrivalMinMs, deltaMs)
          arrivalMaxMs = Math.max(arrivalMaxMs, deltaMs)
        }
        lastPacketPerfAt = packetPerfAt
        receivedPackets += 1
        const chunk = event.chunk.slice(0)
        worklet.port.postMessage({ type: 'chunk', buffer: chunk }, [chunk])
      })

  const unsubscribeEnded = desktop.media.onStreamEnded((id) => {
    if (id !== sessionId) return
    stopped = true
    worklet.port.postMessage({ type: 'end' })
  })

  const unsubscribeError = desktop.media.onStreamError((event) => {
    if (event.sessionId !== sessionId) return
    stopped = true
    worklet.port.postMessage({ type: 'end' })
  })

  const track = destination.stream.getAudioTracks()[0]
  if (!track) {
    unsubscribeChunk()
    unsubscribeEnded()
    unsubscribeError()
    worklet.disconnect()
    await context.close()
    throw new Error('Native audio worklet did not create an audio track')
  }

  return {
    track,
    stop() {
      if (stopped) return
      stopped = true
      unsubscribeChunk()
      unsubscribeEnded()
      unsubscribeError()
      if (!ringMode) {
        worklet.port.postMessage({ type: 'end' })
      }
      worklet.disconnect()
      track.stop()
      void context.close()
    },
  }
}

function getNativePcmWorkletModuleUrl() {
  return new URL('./native-pcm-jitter-buffer.worklet.js', import.meta.url).toString()
}

function canUseNativeAudioWorklet() {
  return (
    typeof AudioContext !== 'undefined' &&
    typeof AudioWorkletNode !== 'undefined' &&
    'audioWorklet' in AudioContext.prototype
  )
}

function pcmF32Rms(samples: Float32Array) {
  let sum = 0
  for (const sample of samples) {
    sum += sample * sample
  }
  return samples.length > 0 ? Math.sqrt(sum / samples.length) : 0
}

function pcmF32Peak(samples: Float32Array) {
  let peak = 0
  for (const sample of samples) {
    peak = Math.max(peak, Math.abs(sample))
  }
  return peak
}

function isNativeMicDebugEnabled() {
  try {
    return globalThis.localStorage?.getItem(NATIVE_MIC_DEBUG_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function postAudioDebugLog(
  _desktop: SyrnikeDesktopApi,
  entry: {
    runId: string
    hypothesisId: string
    location: string
    message: string
    data: Record<string, unknown>
  },
) {
  if (!isNativeMicDebugEnabled()) return
  console.debug('[native-audio-debug]', {
    sessionId: AUDIO_DEBUG_SESSION_ID,
    timestamp: Date.now(),
    ...entry,
  })
}
