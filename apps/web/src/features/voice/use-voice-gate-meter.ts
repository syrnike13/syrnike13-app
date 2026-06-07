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
  VOICE_GATE_DB_MIN,
} from '#/features/voice/voice-gate-level'
import { useVoicePreferences } from '#/features/voice/use-voice-preferences'
import { useVoice } from '#/features/voice/voice-provider'

const DEFAULT_METRICS: VoiceGateMetrics = {
  inputDb: VOICE_GATE_DB_MIN,
  thresholdDb: DEFAULT_VOICE_GATE_THRESHOLD_DB,
  open: false,
}

function agentDebugLog(
  hypothesisId: string,
  message: string,
  data: Record<string, unknown>,
) {
  console.info('[gate-preview-debug]', hypothesisId, message, data)
}

export function useVoiceGateMeter(
  active: boolean,
  inputDeviceId: string | undefined,
  metricsRef?: { current: VoiceGateMetrics },
) {
  const prefs = useVoicePreferences()
  const { status, micPublishing, getNativeMicrophonePreviewTrack } = useVoice()
  const outputRef = metricsRef ?? useRef<VoiceGateMetrics>(DEFAULT_METRICS)
  const gateRef = useRef<VoiceGateStage | null>(null)
  const lastMetricLogAtRef = useRef(0)
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs

  useEffect(() => {
    if (!active) return

    gateRef.current?.updateOptions({
      ...resolveVoiceGateStageOptions(prefs),
    })
  }, [
    active,
    prefs.voiceGateAutoThreshold,
    prefs.voiceGateThresholdDb,
  ])

  useEffect(() => {
    if (!active) {
      agentDebugLog('N', 'gate meter inactive, resetting metrics', {
        active,
        micPublishing,
        reason: 'active_false',
      })
      outputRef.current = DEFAULT_METRICS
      return
    }

    let cancelled = false
    let context: AudioContext | null = null
    let stream: MediaStream | null = null
    let nativeStop: (() => void) | null = null

    const startGateOnTrack = async (
      track: MediaStreamTrack,
      source: 'native-shared' | 'native-dedicated' | 'browser',
    ) => {
      agentDebugLog('J', 'starting gate stage on track', {
        source,
        trackReadyState: track.readyState,
        trackEnabled: track.enabled,
        trackMuted: track.muted,
      })
      context = new AudioContext()
      const gate = new VoiceGateStage(prefsRef.current.voiceGateThresholdDb)
      gateRef.current = gate
      gate.start(context, track, {
        ...resolveVoiceGateStageOptions(prefsRef.current),
        onMetrics: (next) => {
          if (!cancelled) {
            outputRef.current = next
            const now = Date.now()
            if (now - lastMetricLogAtRef.current > 1000) {
              lastMetricLogAtRef.current = now
              agentDebugLog('K', 'gate stage emitted metrics', {
                source,
                inputDb: next.inputDb,
                thresholdDb: next.thresholdDb,
                open: next.open,
              })
            }
          }
        },
      })
      await context.resume()
      agentDebugLog('J', 'audio context resumed for gate meter', {
        source,
        contextState: context.state,
      })
    }

    void (async () => {
      try {
        if (shouldUseNativeMicrophone()) {
          const sharedTrack = getNativeMicrophonePreviewTrack()
          agentDebugLog('I', 'gate meter native branch selected', {
            active,
            micPublishing,
            hasSharedTrack: Boolean(sharedTrack),
            sharedTrackReadyState: sharedTrack?.readyState ?? null,
            sharedTrackEnabled: sharedTrack?.enabled ?? null,
            sharedTrackMuted: sharedTrack?.muted ?? null,
            inputDeviceId: inputDeviceId ?? 'default',
          })
          if (sharedTrack?.readyState === 'live') {
            agentDebugLog('H', 'gate meter using shared native voice track', {
              micPublishing,
            })
            await startGateOnTrack(sharedTrack, 'native-shared')
            return
          }

          if (micPublishing) {
            agentDebugLog('L', 'gate meter has publishing state without shared native track', {
              micPublishing,
              status,
              hasSharedTrack: Boolean(sharedTrack),
              sharedTrackReadyState: sharedTrack?.readyState ?? null,
            })
            if (status === 'connected') return
          }

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

          agentDebugLog('H', 'gate meter started dedicated native preview session', {
            inputDeviceId: inputDeviceId ?? 'default',
          })

          await startGateOnTrack(native.bridge.track, 'native-dedicated')
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

        agentDebugLog('J', 'gate meter browser branch selected', {
          trackReadyState: track.readyState,
          trackEnabled: track.enabled,
          trackMuted: track.muted,
        })
        await startGateOnTrack(track, 'browser')
      } catch (error) {
        agentDebugLog('M', 'gate meter failed to start or update', {
          message: error instanceof Error ? error.message : String(error),
        })
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
      stream?.getTracks().forEach((track) => track.stop())
      void context?.close()
      outputRef.current = DEFAULT_METRICS
    }
  }, [
    active,
    getNativeMicrophonePreviewTrack,
    inputDeviceId,
    micPublishing,
    outputRef,
    prefs.echoCancellation,
    status,
  ])

  return outputRef
}
