import { beforeAll, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (...args: unknown[]) => unknown) => {
        electron.handlers.set(channel, handler)
      },
    ),
  },
}))

vi.mock('electron', () => ({
  ipcMain: electron.ipcMain,
}))

import { IPC } from '@syrnike13/platform'

import type {
  NativeMediaController,
  NativeMediaControllerEvent,
} from './native-media-controller'
import { registerNativeMediaIpc } from './media-ipc'

describe('native media runtime IPC', () => {
  const sender = { send: vi.fn() }
  const window = {
    isDestroyed: () => false,
    webContents: sender,
  }
  let controllerListener:
    | ((event: NativeMediaControllerEvent) => void)
    | null = null
  const runtimeState = {
    available: true,
    status: 'degraded' as const,
    restartCount: 3,
    degradedReason: 'circuit open',
    degradedRetryAttempt: 1,
    nextRetryAt: 30_000,
  }
  const controller = {
    subscribe: vi.fn((listener: (event: NativeMediaControllerEvent) => void) => {
      controllerListener = listener
      return () => undefined
    }),
    getRuntimeState: vi.fn(() => runtimeState),
    retryRuntime: vi.fn(async () => ({
      ...runtimeState,
      status: 'ready' as const,
    })),
  } as unknown as NativeMediaController

  beforeAll(() => {
    registerNativeMediaIpc(
      () => window as never,
      controller,
    )
  })

  it('serves trusted state and retry requests through the controller', async () => {
    const event = { sender }
    await expect(
      electron.handlers.get(IPC.mediaGetRuntimeState)?.(event),
    ).resolves.toEqual(runtimeState)
    await expect(
      electron.handlers.get(IPC.mediaRetryRuntime)?.(event),
    ).resolves.toMatchObject({ status: 'ready' })
    expect(controller.retryRuntime).toHaveBeenCalledTimes(1)
  })

  it('forwards supervisor state changes to the renderer', () => {
    controllerListener?.({ type: 'runtimeState', state: runtimeState })
    expect(sender.send).toHaveBeenCalledWith(
      IPC.mediaRuntimeStateChanged,
      runtimeState,
    )
  })
})
