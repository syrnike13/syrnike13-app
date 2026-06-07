import { useEffect, useRef } from 'react'

import { voiceAudioProcessingConstraints } from '#/features/voice/voice-capture'
import {
  shouldUseNativeMicrophone,
  startNativeMicrophoneTrack,
} from '#/features/voice/native-microphone-publish'
import { resolveVoiceGateStageOptions } from '#/features/voice/voice-gate-session'
import {
  VoiceGateStage,
  type VoiceGateMetrics,
} from '#/features/voice/voice-gate-stage'
import {
  DEFAULT_VOICE_GATE_THRESHOLD_DB,
  rmsFromByteTimeDomain,
  rmsToDb,
  VOICE_GATE_DB_MIN,
} from '#/features/voice/voice-gate-level'
import { useVoicePreferences } from '#/features/voice/use-voice-preferences'

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
  const internalMetricsRef = useRef<VoiceGateMetrics>(DEFAULT_METRICS)
  const outputRef = metricsRef ?? internalMetricsRef
  const gateRef = useRef<VoiceGateStage | null>(null)
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs

  useEffect(() => {
    if (!active) return

    gateRef.current?.updateOptions({
      ...resolveVoiceGateStageOptions(prefs),
    })
  }, [active, prefs.voiceGateAutoThreshold, prefs.voiceGateThresholdDb])

  useEffect(() => {
    if (!active) {
      outputRef.current = DEFAULT_METRICS
      return
    }

    let cancelled = false
    let context: AudioContext | null = null
    let stream: MediaStream | null = null
    let nativeStop: (() => void) | null = null
    let frame = 0

    void (async () => {
      try {
        if (shouldUseNativeMicrophone()) {
          const native = await startNativeMicrophoneTrack(
            prefsRef.current,
            inputDeviceId,
          )
          let nativeStopped = false
          nativeStop = () => {
            if (nativeStopped) return
            nativeStopped = true
            native.bridge.stop()
            native.bridge.track.stop()
            void native.desktop.media.stopSession(native.session.sessionId)
          }
          if (cancelled) {
            nativeStop()
            return
          }

          context = new AudioContext()
          const analyser = context.createAnalyser()
          analyser.fftSize = 512
          const source = context.createMediaStreamSource(
            new MediaStream([native.bridge.track]),
          )
          source.connect(analyser)
          await context.resume()

          const samples = new Uint8Array(analyser.fftSize)
          const tick = () => {
            if (cancelled) return
            analyser.getByteTimeDomainData(samples)
            const inputDb = rmsToDb(rmsFromByteTimeDomain(samples))
            const thresholdDb = prefsRef.current.voiceGateThresholdDb
            outputRef.current = {
              inputDb,
              thresholdDb,
              open: inputDb >= thresholdDb,
            }
            frame = requestAnimationFrame(tick)
          }
          frame = requestAnimationFrame(tick)
          return
        }

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
      } catch {
        if (!cancelled) {
          outputRef.current = DEFAULT_METRICS
        }
      }
    })()

    return () => {
      cancelled = true
      gateRef.current?.destroy()
      gateRef.current = null
      nativeStop?.()
      if (frame) cancelAnimationFrame(frame)
      stream?.getTracks().forEach((track) => track.stop())
      void context?.close()
      outputRef.current = DEFAULT_METRICS
    }
  }, [
    active,
    inputDeviceId,
    outputRef,
    prefs.echoCancellation,
    prefs.noiseSuppression,
  ])

  return outputRef
}
