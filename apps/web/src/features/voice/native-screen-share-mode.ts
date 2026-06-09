import type { ScreenShareCaptureMode } from '#/features/voice/voice-preference-types'
import { getSyrnikeDesktop } from '#/platform/runtime'

export function shouldUseNativeScreenShare(mode: ScreenShareCaptureMode) {
  if (mode === 'native') {
    return getSyrnikeDesktop()?.platform.os === 'win32'
  }
  return getSyrnikeDesktop()?.platform.os === 'win32'
}
