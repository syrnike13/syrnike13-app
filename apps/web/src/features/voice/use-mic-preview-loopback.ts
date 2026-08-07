import { useEffect, useRef, useState, type RefObject } from 'react'
import { Deferred, Effect, Fiber } from 'effect'

import {
  MIC_PREVIEW_METER_BAR_COUNT,
  startMicPreviewEffect,
  type MicPreviewPreferences,
  type MicPreviewSession,
} from '#/features/voice/voice-mic-preview'
import type { VoiceGateMetrics } from '#/features/voice/voice-gate-stage'
import { useVoicePreferences } from '#/features/voice/use-voice-preferences'

function gatePrefsChanged(
  previous: MicPreviewPreferences,
  next: MicPreviewPreferences,
) {
  return (
    previous.voiceGateThresholdDb !== next.voiceGateThresholdDb ||
    previous.voiceGateAutoThreshold !== next.voiceGateAutoThreshold
  )
}

function nonGateProcessingChanged(
  previous: MicPreviewPreferences,
  next: MicPreviewPreferences,
) {
  return (
    previous.bypassSystemAudioInputProcessing !==
      next.bypassSystemAudioInputProcessing ||
    previous.automaticGainControl !== next.automaticGainControl ||
    previous.noiseSuppression !== next.noiseSuppression ||
    previous.echoCancellation !== next.echoCancellation ||
    previous.voiceGateEnabled !== next.voiceGateEnabled ||
    previous.inputVolume !== next.inputVolume
  )
}

export function useMicPreviewLoopback(
  active: boolean,
  inputDeviceId: string | undefined,
  outputDeviceId: string | undefined,
  gateMetricsRef?: RefObject<VoiceGateMetrics>,
) {
  const prefs = useVoicePreferences()
  const [levels, setLevels] = useState(() =>
    Array.from({ length: MIC_PREVIEW_METER_BAR_COUNT }, () => 0),
  )
  const sessionRef = useRef<MicPreviewSession | null>(null)
  const processingPrefsRef = useRef<MicPreviewPreferences | null>(null)

  const previewPrefs: MicPreviewPreferences = {
    bypassSystemAudioInputProcessing:
      prefs.bypassSystemAudioInputProcessing,
    automaticGainControl: prefs.automaticGainControl,
    noiseSuppression: prefs.noiseSuppression,
    echoCancellation: prefs.echoCancellation,
    voiceGateEnabled: prefs.voiceGateEnabled,
    voiceGateThresholdDb: prefs.voiceGateThresholdDb,
    voiceGateAutoThreshold: prefs.voiceGateAutoThreshold,
    inputVolume: prefs.inputVolume,
    outputVolume: prefs.outputVolume,
  }

  useEffect(() => {
    if (!active) {
      sessionRef.current?.stop()
      sessionRef.current = null
      processingPrefsRef.current = null
      setLevels(Array.from({ length: MIC_PREVIEW_METER_BAR_COUNT }, () => 0))
      return
    }

    let acceptUpdates = true
    const ended = Deferred.makeUnsafe<void>()
    const acquireSession = startMicPreviewEffect({
      inputDeviceId,
      outputDeviceId,
      prefs: previewPrefs,
      onLevels: (nextLevels) => {
        if (acceptUpdates) {
          setLevels([...nextLevels])
        }
      },
      onGateMetrics: gateMetricsRef
        ? (metrics) => {
            gateMetricsRef.current = metrics
          }
        : undefined,
      onEnded: () => {
        Effect.runFork(Deferred.succeed(ended, undefined))
      },
    })
    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function*() {
          const session = yield* Effect.acquireRelease(
            acquireSession,
            (acquiredSession) =>
              Effect.sync(() => {
                acquiredSession.stop()
              }),
          )
          if (!acceptUpdates) return
          yield* Effect.sync(() => {
            sessionRef.current = session
            processingPrefsRef.current = previewPrefs
          })
          yield* Deferred.await(ended)
          yield* Effect.sync(() => {
            if (!acceptUpdates || sessionRef.current !== session) return
            sessionRef.current = null
            processingPrefsRef.current = null
            setLevels(
              Array.from(
                { length: MIC_PREVIEW_METER_BAR_COUNT },
                () => 0,
              ),
            )
          })
        }),
      ).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            if (!acceptUpdates) return
            sessionRef.current = null
            processingPrefsRef.current = null
            setLevels(
              Array.from(
                { length: MIC_PREVIEW_METER_BAR_COUNT },
                () => 0,
              ),
            )
          }),
        ),
      ),
    )

    return () => {
      acceptUpdates = false
      sessionRef.current = null
      processingPrefsRef.current = null
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [active, gateMetricsRef, inputDeviceId, outputDeviceId])

  useEffect(() => {
    const session = sessionRef.current
    if (!active || !session) return

    session.setOutputVolume(prefs.outputVolume)
    Effect.runFork(session.setOutputDeviceEffect(outputDeviceId))
  }, [active, outputDeviceId, prefs.outputVolume])

  useEffect(() => {
    const session = sessionRef.current
    if (!active || !session) return

    const previous = processingPrefsRef.current
    if (!previous) return

    const gateChanged = gatePrefsChanged(previous, previewPrefs)
    const otherChanged = nonGateProcessingChanged(previous, previewPrefs)

    if (!gateChanged && !otherChanged) return

    processingPrefsRef.current = previewPrefs

    if (gateChanged && !otherChanged) {
      session.updateGatePreferences(previewPrefs)
      return
    }

    Effect.runFork(
      session.restartProcessingEffect(previewPrefs).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            session.stop()
            sessionRef.current = null
            setLevels(
              Array.from(
                { length: MIC_PREVIEW_METER_BAR_COUNT },
                () => 0,
              ),
            )
          }),
        ),
      ),
    )
  }, [
    active,
    previewPrefs.bypassSystemAudioInputProcessing,
    previewPrefs.automaticGainControl,
    previewPrefs.noiseSuppression,
    previewPrefs.echoCancellation,
    previewPrefs.voiceGateEnabled,
    previewPrefs.voiceGateThresholdDb,
    previewPrefs.voiceGateAutoThreshold,
    previewPrefs.inputVolume,
  ])

  return levels
}
