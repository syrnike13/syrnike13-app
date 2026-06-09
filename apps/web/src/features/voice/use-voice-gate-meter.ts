import { useEffect, useRef } from 'react'

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
  configureNativeMicrophoneRuntime,
  NATIVE_MICROPHONE_MONITOR_SESSION_ID,
} from './native-microphone-runtime-config'

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

    configureNativeMicrophoneRuntime(NATIVE_MICROPHONE_MONITOR_SESSION_ID, {
      echoCancellation: prefs.echoCancellation,
      inputVolume: prefs.inputVolume,
      voiceGateEnabled: prefs.voiceGateEnabled,
      voiceGateThresholdDb: prefs.voiceGateThresholdDb,
      voiceGateAutoThreshold: prefs.voiceGateAutoThreshold,
    })
  }, [
    active,
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

    let cancelled = false
    let context: AudioContext | null = null
    let stream: MediaStream | null = null

    const startGateOnTrack = async (
      track: MediaStreamTrack,
    ) => {
      context = new AudioContext()
      const gate = new VoiceGateStage(prefsRef.current.voiceGateThresholdDb)
      gateRef.current = gate
      gate.start(context, track, {
        ...resolveVoiceGateStageOptions(prefsRef.current),
        onMetrics: (next) => {
          if (!cancelled) {
            outputRef.current = next
          }
        },
      })
      await context.resume()
    }

    void (async () => {
      try {
        const captureConstraints = voiceAudioProcessingConstraints(prefsRef.current)
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...captureConstraints,
            deviceId: inputDeviceId ? { exact: inputDeviceId } : undefined,
          },
        })

        const track = stream.getAudioTracks()[0]
        if (!track) {
          throw new Error('Microphone track is unavailable')
        }

        await startGateOnTrack(track)
      } catch (error) {
        if (!cancelled) {
          outputRef.current = DEFAULT_METRICS
        }
      }
    })()

    return () => {
      cancelled = true
      gateRef.current?.destroy()
      gateRef.current = null
      stream?.getTracks().forEach((track) => track.stop())
      void context?.close()
      outputRef.current = DEFAULT_METRICS
    }
  }, [
    active,
    inputDeviceId,
    outputRef,
    prefs.echoCancellation,
  ])

  return outputRef
}
