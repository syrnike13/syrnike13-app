import { useEffect, useRef, useState, type RefObject } from 'react'

import {
  MIC_PREVIEW_METER_BAR_COUNT,
  startMicPreview,
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
    previous.echoCancellation !== next.echoCancellation ||
    previous.noiseSuppression !== next.noiseSuppression ||
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
    echoCancellation: prefs.echoCancellation,
    noiseSuppression: prefs.noiseSuppression,
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

    let cancelled = false

    void (async () => {
      try {
        const session = await startMicPreview({
          inputDeviceId,
          outputDeviceId,
          prefs: previewPrefs,
          onLevels: (nextLevels) => {
            if (!cancelled) {
              setLevels([...nextLevels])
            }
          },
          onGateMetrics: gateMetricsRef
            ? (metrics) => {
                gateMetricsRef.current = metrics
              }
            : undefined,
        })
        if (cancelled) {
          session.stop()
          return
        }
        sessionRef.current = session
        processingPrefsRef.current = previewPrefs
      } catch {
        if (!cancelled) {
          setLevels(Array.from({ length: MIC_PREVIEW_METER_BAR_COUNT }, () => 0))
        }
      }
    })()

    return () => {
      cancelled = true
      sessionRef.current?.stop()
      sessionRef.current = null
      processingPrefsRef.current = null
    }
  }, [active, gateMetricsRef, inputDeviceId, outputDeviceId])

  useEffect(() => {
    const session = sessionRef.current
    if (!active || !session) return

    session.setOutputVolume(prefs.outputVolume)
    void session.setOutputDevice(outputDeviceId)
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

    void session.restartProcessing(previewPrefs).catch(() => {
      session.stop()
      sessionRef.current = null
      setLevels(Array.from({ length: MIC_PREVIEW_METER_BAR_COUNT }, () => 0))
    })
  }, [
    active,
    previewPrefs.echoCancellation,
    previewPrefs.noiseSuppression,
    previewPrefs.voiceGateEnabled,
    previewPrefs.voiceGateThresholdDb,
    previewPrefs.voiceGateAutoThreshold,
    previewPrefs.inputVolume,
  ])

  return levels
}
