import type { NativeMicrophoneRuntimeConfig } from '@syrnike13/platform'

import { getSyrnikeDesktop } from '#/platform/runtime'

const CONFIGURE_DEBOUNCE_MS = 40
export const NATIVE_MICROPHONE_MONITOR_SESSION_ID = 'native-microphone-monitor'
const pendingConfigs = new Map<
  string,
  {
    config: NativeMicrophoneRuntimeConfig
    timer: ReturnType<typeof setTimeout>
  }
>()

export function configureNativeMicrophoneRuntime(
  sessionId: string | undefined,
  config: NativeMicrophoneRuntimeConfig,
) {
  const desktop = getSyrnikeDesktop()
  if (!desktop || !sessionId) return

  const pending = pendingConfigs.get(sessionId)
  if (pending) {
    clearTimeout(pending.timer)
  }

  const next = {
    ...pending?.config,
    ...config,
  }

  const timer = setTimeout(() => {
    pendingConfigs.delete(sessionId)
    void desktop.media.configureMicrophoneRuntime(sessionId, next).catch(() => {})
  }, CONFIGURE_DEBOUNCE_MS)

  pendingConfigs.set(sessionId, { config: next, timer })
}

export function clearNativeMicrophoneRuntimeConfig(sessionId: string | undefined) {
  if (!sessionId) return

  const pending = pendingConfigs.get(sessionId)
  if (!pending) return

  clearTimeout(pending.timer)
  pendingConfigs.delete(sessionId)
}
