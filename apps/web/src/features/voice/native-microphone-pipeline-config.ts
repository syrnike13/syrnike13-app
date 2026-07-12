import type { NativeMicrophonePipelineConfig } from '@syrnike13/platform'

import { getSyrnikeDesktop } from '#/platform/runtime'

const CONFIGURE_DEBOUNCE_MS = 40
let pendingConfig: NativeMicrophonePipelineConfig | null = null
let pendingTimer: ReturnType<typeof setTimeout> | null = null

function clearPendingNativeMicrophonePipelineConfig() {
  if (!pendingTimer) return
  clearTimeout(pendingTimer)
  pendingTimer = null
  pendingConfig = null
}

async function configureNativeMicrophonePipelineNow(
  config: NativeMicrophonePipelineConfig,
) {
  const desktop = getSyrnikeDesktop()
  if (!desktop) return
  await desktop.voice.dispatch({
    type: 'configureMicrophone',
    deviceId: config.deviceId ?? undefined,
    noiseSuppression: config.noiseSuppression,
    echoCancellation: config.echoCancellation,
    inputVolume: config.inputVolume,
    voiceGateEnabled: config.voiceGateEnabled,
    voiceGateThresholdDb: config.voiceGateThresholdDb,
    voiceGateAutoThreshold: config.voiceGateAutoThreshold,
  })
}

export function configureNativeMicrophonePipeline(
  config: NativeMicrophonePipelineConfig,
) {
  if (pendingTimer) {
    clearTimeout(pendingTimer)
  }

  pendingConfig = config
  pendingTimer = setTimeout(() => {
    const next = pendingConfig
    pendingConfig = null
    pendingTimer = null
    if (!next) return
    void configureNativeMicrophonePipelineNow(next).catch(() => {})
  }, CONFIGURE_DEBOUNCE_MS)
}

export async function applyNativeMicrophonePipeline(
  config: NativeMicrophonePipelineConfig,
) {
  clearPendingNativeMicrophonePipelineConfig()
  await configureNativeMicrophonePipelineNow(config)
}
