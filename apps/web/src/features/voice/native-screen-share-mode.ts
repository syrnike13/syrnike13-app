import type { NativeCaptureStreamMode } from '@syrnike13/platform'

import type { ScreenShareCaptureMode } from '#/features/voice/voice-preference-types'
import { getSyrnikeDesktop } from '#/platform/runtime'

export function shouldUseNativeScreenShare(mode: ScreenShareCaptureMode) {
  if (mode === 'native') {
    return getSyrnikeDesktop()?.platform.os === 'win32'
  }
  return getSyrnikeDesktop()?.platform.os === 'win32'
}

export function defaultNativeCaptureStreamMode(): NativeCaptureStreamMode {
  if (
    typeof import.meta !== 'undefined' &&
    import.meta.env?.VITE_NATIVE_CAPTURE_BGRA === 'true'
  ) {
    return 'bgra'
  }
  if (getSyrnikeDesktop()?.platform.os === 'win32') {
    return 'h264'
  }
  return 'bgra'
}
