import { IPC } from '@syrnike13/platform'
import type { BrowserWindow } from 'electron'

import type {
  NativeSharedVideoFrame,
  NativeVideoPresentationStallReason,
} from './shared-texture-bridge'

type PresentationRecoveryDependencies = {
  getWindow(): BrowserWindow | null
  recoverRemoteVideoDemand(
    sessionId: string,
    generation: number,
    trackId: string,
  ): Promise<boolean>
  recoverLocalScreenPreview(): Promise<boolean>
  recoverLocalCameraPreview(): Promise<boolean>
}

export type NativeVideoPresentationRecoveryOutcome =
  | 'window-unavailable'
  | 'remote-track-restarted'
  | 'remote-track-not-demanded'
  | 'local-preview-restarted'
  | 'local-preview-not-demanded'
  | 'renderer-reloaded'

export async function recoverNativeVideoPresentation(
  dependencies: PresentationRecoveryDependencies,
  frame: NativeSharedVideoFrame,
  reason: NativeVideoPresentationStallReason,
): Promise<NativeVideoPresentationRecoveryOutcome> {
  const window = dependencies.getWindow()
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return 'window-unavailable'
  }
  window.webContents.send(IPC.mediaNativeVideoPresentationReset, {
    sessionId: frame.sessionId,
    generation: frame.generation,
    trackId: frame.trackId,
  })

  if (reason === 'retained-budget-exhausted' ||
    reason === 'retired-fence-deadline') {
    window.webContents.reload()
    return 'renderer-reloaded'
  }
  if (frame.local) {
    const recovered = frame.source === 'screen'
      ? await dependencies.recoverLocalScreenPreview()
      : frame.source === 'camera'
        ? await dependencies.recoverLocalCameraPreview()
        : false
    return recovered
      ? 'local-preview-restarted'
      : 'local-preview-not-demanded'
  }
  return await dependencies.recoverRemoteVideoDemand(
    frame.sessionId,
    frame.generation,
    frame.trackId,
  )
    ? 'remote-track-restarted'
    : 'remote-track-not-demanded'
}
