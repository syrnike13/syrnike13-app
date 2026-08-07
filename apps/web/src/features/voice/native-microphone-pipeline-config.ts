import type { NativeMicrophonePipelineConfig } from '@syrnike13/platform'
import { Effect, Fiber } from 'effect'

import { getSyrnikeDesktop } from '#/platform/runtime'

const CONFIGURE_DEBOUNCE_MS = 40
let pendingConfig: NativeMicrophonePipelineConfig | null = null
let pendingTimer: Fiber.Fiber<void, never> | null = null

function clearPendingNativeMicrophonePipelineConfig() {
  if (!pendingTimer) return
  Effect.runFork(Fiber.interrupt(pendingTimer))
  pendingTimer = null
  pendingConfig = null
}

const configureNativeMicrophonePipelineNow = Effect.fn(
  'voice.configureNativeMicrophonePipeline',
)(function*(config: NativeMicrophonePipelineConfig) {
  const desktop = getSyrnikeDesktop()
  if (!desktop) return
  yield* Effect.tryPromise({
    try: () =>
      desktop.voice.dispatch({
        type: 'configureMicrophone',
        deviceId: config.deviceId ?? undefined,
        bypassSystemAudioInputProcessing:
          config.bypassSystemAudioInputProcessing,
        automaticGainControl: config.automaticGainControl,
        noiseSuppression: config.noiseSuppression,
        echoCancellation: config.echoCancellation,
        inputVolume: config.inputVolume,
        voiceGateEnabled: config.voiceGateEnabled,
        voiceGateThresholdDb: config.voiceGateThresholdDb,
        voiceGateAutoThreshold: config.voiceGateAutoThreshold,
      }),
    catch: (cause) => cause,
  })
})

export function configureNativeMicrophonePipeline(
  config: NativeMicrophonePipelineConfig,
) {
  if (pendingTimer) {
    Effect.runFork(Fiber.interrupt(pendingTimer))
  }

  pendingConfig = config
  let fiber: Fiber.Fiber<void, never>
  const effect = Effect.sleep(CONFIGURE_DEBOUNCE_MS).pipe(
    Effect.andThen(
      Effect.gen(function*() {
        if (pendingTimer !== fiber) return
        const next = pendingConfig
        pendingConfig = null
        pendingTimer = null
        if (!next) return
        yield* configureNativeMicrophonePipelineNow(next).pipe(
          Effect.catch(() => Effect.void),
        )
      }),
    ),
  )
  fiber = Effect.runFork(effect)
  pendingTimer = fiber
}

export const applyNativeMicrophonePipelineEffect = Effect.fn(
  'voice.applyNativeMicrophonePipeline',
)(function*(config: NativeMicrophonePipelineConfig) {
  yield* Effect.sync(clearPendingNativeMicrophonePipelineConfig)
  yield* configureNativeMicrophonePipelineNow(config)
})

export function applyNativeMicrophonePipeline(
  config: NativeMicrophonePipelineConfig,
) {
  return Effect.runPromise(applyNativeMicrophonePipelineEffect(config))
}
