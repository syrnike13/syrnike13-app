import { IPC } from '@syrnike13/platform'
import { describe, expect, it, vi } from 'vitest'

import { recoverNativeVideoPresentation } from './presentation-recovery'
import type { NativeSharedVideoFrame } from './shared-texture-bridge'

const frame: NativeSharedVideoFrame = {
  sessionId: 'voice',
  generation: 3,
  trackId: 'screen',
  participantIdentity: 'remote',
  source: 'screen',
  local: false,
  sequence: 7,
  width: 1280,
  height: 720,
  timestampUs: 1_000,
  runtimeEpoch: 0,
  ntHandle: Buffer.alloc(8),
}

function harness() {
  const send = vi.fn()
  const reload = vi.fn()
  const recoverRemoteVideoDemand = vi.fn(async () => true)
  const recoverLocalScreenPreview = vi.fn(async () => true)
  const recoverLocalCameraPreview = vi.fn(async () => true)
  return {
    dependencies: {
      getWindow: () => ({
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send,
          reload,
        },
      }) as never,
      recoverRemoteVideoDemand,
      recoverLocalScreenPreview,
      recoverLocalCameraPreview,
    },
    send,
    reload,
    recoverRemoteVideoDemand,
    recoverLocalScreenPreview,
    recoverLocalCameraPreview,
  }
}

describe('native video presentation recovery', () => {
  it('resets renderer state and restarts a demanded remote decoder', async () => {
    const h = harness()

    await expect(recoverNativeVideoPresentation(
      h.dependencies,
      frame,
      'renderer-delivery',
    )).resolves.toBe('remote-track-restarted')

    expect(h.send).toHaveBeenCalledWith(
      IPC.mediaNativeVideoPresentationReset,
      {
        sessionId: frame.sessionId,
        generation: frame.generation,
        trackId: frame.trackId,
      },
    )
    expect(h.recoverRemoteVideoDemand).toHaveBeenCalledWith(
      frame.sessionId,
      frame.generation,
      frame.trackId,
    )
    expect(h.reload).not.toHaveBeenCalled()
  })

  it('reasserts a demanded local screen preview without touching remote demand', async () => {
    const h = harness()

    await expect(recoverNativeVideoPresentation(
      h.dependencies,
      { ...frame, local: true },
      'shared-texture-fence',
    )).resolves.toBe('local-preview-restarted')

    expect(h.recoverLocalScreenPreview).toHaveBeenCalledOnce()
    expect(h.recoverRemoteVideoDemand).not.toHaveBeenCalled()
    expect(h.reload).not.toHaveBeenCalled()
  })

  it('retries a demanded local camera preview through its native owner', async () => {
    const h = harness()

    await expect(recoverNativeVideoPresentation(
      h.dependencies,
      { ...frame, local: true, source: 'camera', trackId: 'local-camera' },
      'shared-texture-fence',
    )).resolves.toBe('local-preview-restarted')

    expect(h.recoverLocalCameraPreview).toHaveBeenCalledOnce()
    expect(h.recoverLocalScreenPreview).not.toHaveBeenCalled()
    expect(h.recoverRemoteVideoDemand).not.toHaveBeenCalled()
  })

  it('reloads the renderer when retained GPU references exhaust the hard budget', async () => {
    const h = harness()

    await expect(recoverNativeVideoPresentation(
      h.dependencies,
      frame,
      'retained-budget-exhausted',
    )).resolves.toBe('renderer-reloaded')

    expect(h.send).toHaveBeenCalledOnce()
    expect(h.reload).toHaveBeenCalledOnce()
    expect(h.recoverRemoteVideoDemand).not.toHaveBeenCalled()
    expect(h.recoverLocalScreenPreview).not.toHaveBeenCalled()
    expect(h.recoverLocalCameraPreview).not.toHaveBeenCalled()
  })

  it('reloads the renderer when retired fences miss their independent deadline', async () => {
    const h = harness()

    await expect(recoverNativeVideoPresentation(
      h.dependencies,
      frame,
      'retired-fence-deadline',
    )).resolves.toBe('renderer-reloaded')

    expect(h.reload).toHaveBeenCalledOnce()
    expect(h.recoverRemoteVideoDemand).not.toHaveBeenCalled()
  })
})
