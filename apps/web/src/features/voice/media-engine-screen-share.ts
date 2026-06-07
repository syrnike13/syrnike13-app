import { toast } from 'sonner'

import { screenShareCaptureOptions } from '#/features/voice/voice-capture'
import { nativeCaptureStatsStore } from '#/features/voice/native-capture-stats'
import type { ScreenShareQualityName } from '#/features/voice/voice-preference-types'
import { getSyrnikeDesktop } from '#/platform/runtime'
import type { MediaEngineRoomConnectParams } from '@syrnike13/platform'

export type MediaEngineScreenShareSession = {
  stop: () => Promise<void>
}

export async function startMediaEngineScreenShare(
  livekitSession: MediaEngineRoomConnectParams,
  sourceId: string,
  quality: ScreenShareQualityName,
  withAudio: boolean,
): Promise<MediaEngineScreenShareSession> {
  const desktop = getSyrnikeDesktop()
  if (!desktop) {
    throw new Error('Desktop bridge is not available')
  }

  const capture = screenShareCaptureOptions(quality)
  const encoding = capture.publish.screenShareEncoding

  await desktop.mediaEngine.roomConnect(livekitSession)

  const result = await desktop.mediaEngine.screenStart({
    sourceId,
    width: capture.capture.resolution.width,
    height: capture.capture.resolution.height,
    fps: capture.capture.resolution.frameRate ?? 30,
    maxBitrate: encoding?.maxBitrate,
    withAudio,
  })

  nativeCaptureStatsStore.setNative(
    {
      wgc: result.activeMethod === 'wgc' ? 1 : 0,
      dxgi: result.activeMethod === 'dxgi' ? 1 : 0,
      gdi_blt: result.activeMethod === 'gdi_blt' ? 1 : 0,
      gdi_print: result.activeMethod === 'gdi_print' ? 1 : 0,
    },
    result.activeMethod as 'wgc' | 'dxgi' | 'gdi_blt' | 'gdi_print',
  )

  if (withAudio && result.audioMode === 'none') {
    toast.warning('Системный звук для этой демонстрации недоступен')
  }

  return {
    async stop() {
      await desktop.mediaEngine.screenStop()
      await desktop.mediaEngine.roomDisconnect()
      nativeCaptureStatsStore.reset()
    },
  }
}
