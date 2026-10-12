import { Track } from 'livekit-client'
import { Effect } from 'effect'

import { voiceAudioProcessingConstraints } from '#/features/voice/voice-capture'
import {
  createMicProcessorConfigFromPrefs,
  micProcessingNeeded,
  SyrnikeMicProcessor,
} from '#/features/voice/voice-mic-processor'
import type { VoicePreferenceState } from '#/features/voice/voice-preference-store'
import { resolveVoiceGateStageOptions } from '#/features/voice/voice-gate-session'
import type { VoiceGateMetrics } from '#/features/voice/voice-gate-stage'
import {
  dbToRms,
  rmsFromByteTimeDomain,
} from '#/features/voice/voice-gate-level'
import { getSyrnikeDesktop } from '#/platform/runtime'

import {
  applyNativeMicrophonePipelineEffect,
  configureNativeMicrophonePipeline,
} from './native-microphone-pipeline-config'
import { nativeMicrophonePipelineConfig } from './native-microphone-publish'

export const MIC_PREVIEW_METER_BAR_COUNT = 32

export type MicPreviewPreferences = Pick<
  VoicePreferenceState,
  | 'bypassSystemAudioInputProcessing'
  | 'automaticGainControl'
  | 'echoCancellation'
  | 'noiseSuppression'
  | 'voiceGateEnabled'
  | 'voiceGateThresholdDb'
  | 'voiceGateAutoThreshold'
  | 'inputVolume'
  | 'outputVolume'
>

type MicPreviewOptions = {
  inputDeviceId?: string
  outputDeviceId?: string
  prefs: MicPreviewPreferences
  onLevels: (levels: readonly number[]) => void
  onGateMetrics?: (metrics: VoiceGateMetrics) => void
  onEnded?: (message?: string) => void
}

export function meterLevelsFromRms(rms: number, barCount: number) {
  const level = Math.min(1, rms * 6)
  return Array.from({ length: barCount }, (_, index) => {
    const wave = 0.65 + ((index % 7) + 1) / 14
    return level * wave
  })
}

function applyPlaybackSinkEffect(context: AudioContext, deviceId?: string) {
  const sink = context as AudioContext & {
    setSinkId?: (sinkId: string) => Promise<void>
  }
  if (!deviceId || !sink.setSinkId) return Effect.void
  return Effect.tryPromise({
    try: () => sink.setSinkId?.(deviceId) ?? Promise.resolve(),
    catch: (cause) => cause,
  }).pipe(
    // Browser rejected the sink; keep the default output device.
    Effect.catch(() => Effect.void),
  )
}

function attachProcessorEffect(
  context: AudioContext,
  rawTrack: MediaStreamTrack,
  prefs: MicPreviewPreferences,
  existing: SyrnikeMicProcessor | null,
  onGateMetrics?: (metrics: VoiceGateMetrics) => void,
) {
  return Effect.gen(function*() {
    if (existing) {
      yield* existing.destroyEffect()
    }

    const config = createMicProcessorConfigFromPrefs(prefs)
    if (!micProcessingNeeded(config)) {
      return { processor: null, playbackTrack: rawTrack }
    }

    const processor = new SyrnikeMicProcessor({
      ...config,
      gateOnMetrics: onGateMetrics,
    })
    yield* processor.initEffect({
      audioContext: context,
      kind: Track.Kind.Audio,
      track: rawTrack,
    })
    return {
      processor,
      playbackTrack: processor.processedTrack ?? rawTrack,
    }
  })
}

export function startMicPreview(options: MicPreviewOptions) {
  return Effect.runPromise(startMicPreviewEffect(options))
}

export function startMicPreviewEffect({
  inputDeviceId,
  outputDeviceId,
  prefs,
  onLevels,
  onGateMetrics,
  onEnded,
}: MicPreviewOptions) {
  return Effect.gen(function*() {
    const desktop = getSyrnikeDesktop()
    if (desktop?.platform.os === 'win32') {
      const configureNativeEffect = (nextPrefs: MicPreviewPreferences) =>
        applyNativeMicrophonePipelineEffect(
          nativeMicrophonePipelineConfig(nextPrefs, inputDeviceId),
        )

      let stopped = false
      let running = false
      let unsubscribeMetrics = () => {}
      let unsubscribeState = () => {}
      const finishFromRuntime = (message?: string) => {
        if (stopped || !running) return
        stopped = true
        running = false
        unsubscribeMetrics()
        unsubscribeState()
        onLevels(Array.from({ length: MIC_PREVIEW_METER_BAR_COUNT }, () => 0))
        onEnded?.(message)
      }

      unsubscribeState = desktop.media.onMicrophonePreviewState((event) => {
        if (event.status === 'running') {
          running = true
          return
        }
        finishFromRuntime(event.status === 'error' ? event.message : undefined)
      })
      unsubscribeMetrics = desktop.media.onMicrophoneMetrics((event) => {
        if (stopped) return
        onLevels(
          meterLevelsFromRms(
            dbToRms(event.inputDb),
            MIC_PREVIEW_METER_BAR_COUNT,
          ),
        )
        onGateMetrics?.({
          inputDb: event.inputDb,
          thresholdDb: event.thresholdDb,
          open: event.open,
        })
      })

      yield* Effect.gen(function*() {
        yield* configureNativeEffect(prefs)
        yield* Effect.tryPromise({
          try: () => desktop.media.startMicrophonePreview(),
          catch: (cause) => cause,
        })
        running = true
      }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            stopped = true
            unsubscribeMetrics()
            unsubscribeState()
          }),
        ),
      )

      const queueNative = (nextPrefs: MicPreviewPreferences) => {
        if (stopped) return
        configureNativeMicrophonePipeline(
          nativeMicrophonePipelineConfig(nextPrefs, inputDeviceId),
        )
      }
      const setOutputDeviceEffect = (_deviceId?: string) => Effect.void
      const restartProcessingEffect = (nextPrefs: MicPreviewPreferences) =>
        Effect.sync(() => queueNative(nextPrefs))

      return {
        setOutputVolume(_volume: number) {},
        setOutputDevice(_deviceId?: string) {
          return Effect.runPromise(setOutputDeviceEffect(_deviceId))
        },
        setOutputDeviceEffect,
        updateGatePreferences(nextPrefs: MicPreviewPreferences) {
          queueNative(nextPrefs)
        },
        restartProcessing(nextPrefs: MicPreviewPreferences) {
          return Effect.runPromise(restartProcessingEffect(nextPrefs))
        },
        restartProcessingEffect,
        stop() {
          if (stopped) return
          stopped = true
          running = false
          unsubscribeMetrics()
          unsubscribeState()
          Effect.runFork(
            Effect.tryPromise({
              try: () => desktop.media.stopMicrophonePreview(),
              catch: (cause) => cause,
            }).pipe(Effect.ignore),
          )
        },
      }
    }

    const captureConstraints = voiceAudioProcessingConstraints(prefs)
    const stream = yield* Effect.tryPromise({
      try: () =>
        navigator.mediaDevices.getUserMedia({
          audio: {
            ...captureConstraints,
            deviceId: inputDeviceId ? { exact: inputDeviceId } : undefined,
          },
        }),
      catch: (cause) => cause,
    })

    const rawTrack = stream.getAudioTracks()[0]
    if (!rawTrack) {
      stream.getTracks().forEach((track) => track.stop())
      return yield* Effect.fail(new Error('Microphone track is unavailable'))
    }

    const processContext = new AudioContext({ sampleRate: 48_000 })
    const playbackContext = new AudioContext({ sampleRate: 48_000 })
    let processor: SyrnikeMicProcessor | null = null
    let playbackTrack: MediaStreamTrack = rawTrack

    const initial = yield* attachProcessorEffect(
      processContext,
      rawTrack,
      prefs,
      null,
      onGateMetrics,
    )
    processor = initial.processor
    playbackTrack = initial.playbackTrack

    const monitorGain = playbackContext.createGain()
    const analyser = playbackContext.createAnalyser()

    analyser.fftSize = 512
    monitorGain.gain.value = prefs.outputVolume

    let sourceNode = playbackContext.createMediaStreamSource(
      new MediaStream([playbackTrack]),
    )
    sourceNode.connect(monitorGain)
    monitorGain.connect(analyser)
    monitorGain.connect(playbackContext.destination)

    yield* applyPlaybackSinkEffect(playbackContext, outputDeviceId)
    yield* Effect.tryPromise({
      try: () => playbackContext.resume(),
      catch: (cause) => cause,
    })

    const samples = new Uint8Array(analyser.fftSize)
    let frame = 0
    let stopped = false
    let previousLevels = Array.from(
      { length: MIC_PREVIEW_METER_BAR_COUNT },
      () => 0,
    )

    const tick = () => {
      if (stopped) return
      analyser.getByteTimeDomainData(samples)
      const targets = meterLevelsFromRms(
        rmsFromByteTimeDomain(samples),
        MIC_PREVIEW_METER_BAR_COUNT,
      )
      previousLevels = previousLevels.map((previous, index) => {
        const target = targets[index] ?? 0
        return previous * 0.45 + target * 0.55
      })
      onLevels(previousLevels)
      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    const setOutputDeviceEffect = (deviceId?: string) =>
      applyPlaybackSinkEffect(playbackContext, deviceId)
    const restartProcessingEffect = (nextPrefs: MicPreviewPreferences) =>
      Effect.gen(function*() {
        sourceNode.disconnect()
        const next = yield* attachProcessorEffect(
          processContext,
          rawTrack,
          nextPrefs,
          processor,
          onGateMetrics,
        )
        processor = next.processor
        playbackTrack = next.playbackTrack
        sourceNode = playbackContext.createMediaStreamSource(
          new MediaStream([playbackTrack]),
        )
        sourceNode.connect(monitorGain)
      })

    return {
      setOutputVolume(volume: number) {
        monitorGain.gain.value = volume
      },
      setOutputDevice(deviceId?: string) {
        return Effect.runPromise(setOutputDeviceEffect(deviceId))
      },
      setOutputDeviceEffect,
      updateGatePreferences(nextPrefs: MicPreviewPreferences) {
        processor?.updateGatePreferences({
          gateThresholdDb: nextPrefs.voiceGateThresholdDb,
          gateAutoThreshold: nextPrefs.voiceGateAutoThreshold,
          gateStageOptions: resolveVoiceGateStageOptions(nextPrefs),
        })
      },
      restartProcessing(nextPrefs: MicPreviewPreferences) {
        return Effect.runPromise(restartProcessingEffect(nextPrefs))
      },
      restartProcessingEffect,
      stop() {
        if (stopped) return
        stopped = true
        cancelAnimationFrame(frame)
        sourceNode.disconnect()
        monitorGain.disconnect()
        analyser.disconnect()
        stream.getTracks().forEach((track) => track.stop())
        Effect.runFork(
          Effect.all(
            [
              processor ? processor.destroyEffect() : Effect.void,
              Effect.tryPromise({
                try: () => processContext.close(),
                catch: (cause) => cause,
              }).pipe(Effect.ignore),
              Effect.tryPromise({
                try: () => playbackContext.close(),
                catch: (cause) => cause,
              }).pipe(Effect.ignore),
            ],
            { concurrency: 'unbounded', discard: true },
          ),
        )
      },
    }
  })
}

export type MicPreviewSession = Awaited<ReturnType<typeof startMicPreview>>
