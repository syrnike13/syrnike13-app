import { voiceAudioProcessingConstraints } from '#/features/voice/voice-capture'
import {
  createMicProcessorConfigFromPrefs,
  micProcessingNeeded,
  SyrnikeMicProcessor,
} from '#/features/voice/voice-mic-processor'
import type { VoicePreferenceState } from '#/features/voice/voice-preference-store'
import { resolveVoiceGateStageOptions } from '#/features/voice/voice-gate-session'
import type { VoiceGateMetrics } from '#/features/voice/voice-gate-stage'
import { rmsFromByteTimeDomain } from '#/features/voice/voice-gate-level'

export const MIC_PREVIEW_METER_BAR_COUNT = 32

export type MicPreviewPreferences = Pick<
  VoicePreferenceState,
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
}

export function meterLevelsFromRms(rms: number, barCount: number) {
  const level = Math.min(1, rms * 6)
  return Array.from({ length: barCount }, (_, index) => {
    const wave = 0.65 + ((index % 7) + 1) / 14
    return level * wave
  })
}

async function applyPlaybackSink(context: AudioContext, deviceId?: string) {
  if (!deviceId || !('setSinkId' in context)) return
  try {
    await context.setSinkId(deviceId)
  } catch {
    // Browser rejected the sink; keep the default output device.
  }
}

async function attachProcessor(
  context: AudioContext,
  rawTrack: MediaStreamTrack,
  prefs: MicPreviewPreferences,
  existing: SyrnikeMicProcessor | null,
  onGateMetrics?: (metrics: VoiceGateMetrics) => void,
) {
  if (existing) {
    await existing.destroy()
  }

  const config = createMicProcessorConfigFromPrefs(prefs)
  if (!micProcessingNeeded(config)) {
    return { processor: null, playbackTrack: rawTrack }
  }

  const processor = new SyrnikeMicProcessor({
    ...config,
    gateOnMetrics: onGateMetrics,
  })
  await processor.init({ audioContext: context, track: rawTrack })
  return {
    processor,
    playbackTrack: processor.processedTrack ?? rawTrack,
  }
}

export async function startMicPreview({
  inputDeviceId,
  outputDeviceId,
  prefs,
  onLevels,
  onGateMetrics,
}: MicPreviewOptions) {
  const captureConstraints = voiceAudioProcessingConstraints(prefs)
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...captureConstraints,
      deviceId: inputDeviceId ? { exact: inputDeviceId } : undefined,
    },
  })

  const rawTrack = stream.getAudioTracks()[0]
  if (!rawTrack) {
    stream.getTracks().forEach((track) => track.stop())
    throw new Error('Microphone track is unavailable')
  }

  const processContext = new AudioContext()
  const playbackContext = new AudioContext()
  let processor: SyrnikeMicProcessor | null = null
  let playbackTrack: MediaStreamTrack = rawTrack

  const initial = await attachProcessor(
    processContext,
    rawTrack,
    prefs,
    null,
    onGateMetrics,
  )
  processor = initial.processor
  playbackTrack = initial.playbackTrack
  await processor?.whenGateCalibrated()

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

  await applyPlaybackSink(playbackContext, outputDeviceId)
  await playbackContext.resume()

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

  return {
    setOutputVolume(volume: number) {
      monitorGain.gain.value = volume
    },
    async setOutputDevice(deviceId?: string) {
      await applyPlaybackSink(playbackContext, deviceId)
    },
    updateGatePreferences(nextPrefs: MicPreviewPreferences) {
      processor?.updateGatePreferences({
        gateThresholdDb: nextPrefs.voiceGateThresholdDb,
        gateAutoThreshold: nextPrefs.voiceGateAutoThreshold,
        gateStageOptions: resolveVoiceGateStageOptions(nextPrefs),
      })
    },
    async restartProcessing(nextPrefs: MicPreviewPreferences) {
      sourceNode.disconnect()

      const next = await attachProcessor(
        processContext,
        rawTrack,
        nextPrefs,
        processor,
        onGateMetrics,
      )
      processor = next.processor
      playbackTrack = next.playbackTrack
      await processor?.whenGateCalibrated()

      sourceNode = playbackContext.createMediaStreamSource(
        new MediaStream([playbackTrack]),
      )
      sourceNode.connect(monitorGain)
    },
    stop() {
      if (stopped) return
      stopped = true
      cancelAnimationFrame(frame)
      sourceNode.disconnect()
      monitorGain.disconnect()
      analyser.disconnect()
      void processor?.destroy()
      stream.getTracks().forEach((track) => track.stop())
      void processContext.close()
      void playbackContext.close()
    },
  }
}

export type MicPreviewSession = Awaited<ReturnType<typeof startMicPreview>>
