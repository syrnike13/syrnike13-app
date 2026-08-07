import { useEffect, useRef } from 'react'
import { Effect, Fiber } from 'effect'

import { voiceAudioProcessingConstraints } from '#/features/voice/voice-capture'
import { resolveVoiceGateStageOptions } from '#/features/voice/voice-gate-session'
import {
  VoiceGateStage,
  type VoiceGateMetrics,
} from '#/features/voice/voice-gate-stage'
import {
  DEFAULT_VOICE_GATE_THRESHOLD_DB,
  VOICE_GATE_DB_MIN,
} from '#/features/voice/voice-gate-level'
import { useVoicePreferences } from '#/features/voice/use-voice-preferences'
import { shouldUseNativeMicrophone } from '#/features/voice/native-microphone-publish'
import { getSyrnikeDesktop } from '#/platform/runtime'

import {
  configureNativeMicrophonePipeline,
} from './native-microphone-pipeline-config'
import { nativeMicrophonePipelineConfig } from './native-microphone-publish'

const DEFAULT_METRICS: VoiceGateMetrics = {
  inputDb: VOICE_GATE_DB_MIN,
  thresholdDb: DEFAULT_VOICE_GATE_THRESHOLD_DB,
  open: false,
}

export function useVoiceGateMeter(
  active: boolean,
  inputDeviceId: string | undefined,
  metricsRef?: { current: VoiceGateMetrics },
) {
  const prefs = useVoicePreferences()
  const outputRef = metricsRef ?? useRef<VoiceGateMetrics>(DEFAULT_METRICS)
  const gateRef = useRef<VoiceGateStage | null>(null)
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs

  useEffect(() => {
    if (!active) return
    if (shouldUseNativeMicrophone()) return

    gateRef.current?.updateOptions({
      ...resolveVoiceGateStageOptions(prefs),
    })
  }, [
    active,
    prefs.voiceGateAutoThreshold,
    prefs.voiceGateThresholdDb,
  ])

  useEffect(() => {
    if (!active) return
    if (!shouldUseNativeMicrophone()) return

    configureNativeMicrophonePipeline(
      nativeMicrophonePipelineConfig({
        bypassSystemAudioInputProcessing:
          prefs.bypassSystemAudioInputProcessing,
        automaticGainControl: prefs.automaticGainControl,
        noiseSuppression: prefs.noiseSuppression,
        echoCancellation: prefs.echoCancellation,
        inputVolume: prefs.inputVolume,
        voiceGateEnabled: prefs.voiceGateEnabled,
        voiceGateThresholdDb: prefs.voiceGateThresholdDb,
        voiceGateAutoThreshold: prefs.voiceGateAutoThreshold,
      }, inputDeviceId),
    )
  }, [
    active,
    inputDeviceId,
    prefs.bypassSystemAudioInputProcessing,
    prefs.automaticGainControl,
    prefs.noiseSuppression,
    prefs.echoCancellation,
    prefs.inputVolume,
    prefs.voiceGateEnabled,
    prefs.voiceGateThresholdDb,
    prefs.voiceGateAutoThreshold,
  ])

  useEffect(() => {
    if (!active) {
      outputRef.current = DEFAULT_METRICS
      return
    }

    if (shouldUseNativeMicrophone()) {
      const desktop = getSyrnikeDesktop()
      if (!desktop) {
        outputRef.current = DEFAULT_METRICS
        return
      }
      return desktop.media.onMicrophoneMetrics((metrics) => {
        outputRef.current = {
          inputDb: metrics.inputDb,
          thresholdDb: metrics.thresholdDb,
          open: metrics.open,
        }
      })
    }

    let acceptUpdates = true
    const captureConstraints = voiceAudioProcessingConstraints(prefsRef.current)
    const acquireStream = Effect.callback<MediaStream, unknown>((resume) => {
      let interrupted = false
      void navigator.mediaDevices
        .getUserMedia({
          audio: {
            ...captureConstraints,
            deviceId: inputDeviceId ? { exact: inputDeviceId } : undefined,
          },
        })
        .then(
          (stream) => {
            if (interrupted) {
              stream.getTracks().forEach((track) => track.stop())
              return
            }
            resume(Effect.succeed(stream))
          },
          (cause) => {
            if (!interrupted) resume(Effect.fail(cause))
          },
        )
      return Effect.sync(() => {
        interrupted = true
      })
    })
    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function*() {
          const stream = yield* Effect.acquireRelease(
            acquireStream,
            (acquiredStream) =>
              Effect.sync(() => {
                acquiredStream.getTracks().forEach((track) => track.stop())
              }),
          )
          const track = stream.getAudioTracks()[0]
          if (!track) {
            return yield* Effect.fail(
              new Error('Microphone track is unavailable'),
            )
          }
          const context = yield* Effect.acquireRelease(
            Effect.try({
              try: () => new AudioContext(),
              catch: (cause) => cause,
            }),
            (acquiredContext) =>
              Effect.tryPromise({
                try: () => acquiredContext.close(),
                catch: (cause) => cause,
              }).pipe(Effect.ignore),
          )
          yield* Effect.acquireRelease(
            Effect.try({
              try: () => {
                const gate = new VoiceGateStage(
                  prefsRef.current.voiceGateThresholdDb,
                )
                gate.start(context, track, {
                  ...resolveVoiceGateStageOptions(prefsRef.current),
                  onMetrics: (next) => {
                    if (acceptUpdates) {
                      outputRef.current = next
                    }
                  },
                })
                gateRef.current = gate
                return gate
              },
              catch: (cause) => cause,
            }),
            (gate) =>
              Effect.sync(() => {
                gate.destroy()
                if (gateRef.current === gate) gateRef.current = null
              }),
          )
          yield* Effect.tryPromise({
            try: () => context.resume(),
            catch: (cause) => cause,
          })
          yield* Effect.never
        }),
      ).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            if (acceptUpdates) outputRef.current = DEFAULT_METRICS
          }),
        ),
      ),
    )

    return () => {
      acceptUpdates = false
      gateRef.current = null
      outputRef.current = DEFAULT_METRICS
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [
    active,
    inputDeviceId,
    outputRef,
    prefs.echoCancellation,
    prefs.automaticGainControl,
  ])

  return outputRef
}
