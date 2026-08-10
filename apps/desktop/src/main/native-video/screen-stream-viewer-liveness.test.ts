import { describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'

import type {
  MediaRuntimeCommand,
  MediaRuntimeEvent,
} from '../native-runtime/contract'
import { NativeMediaController } from '../native-runtime/native-media-controller'
import type {
  NativeRuntimeSupervisor,
  NativeRuntimeSupervisorSnapshot,
} from '../native-runtime/runtime-supervisor'
import {
  NativeSharedTextureBridge,
  type NativeSharedVideoFrame,
  type SharedTextureBridgeDependencies,
} from './shared-texture-bridge'

type ImportTextureOptions = Parameters<
  NonNullable<SharedTextureBridgeDependencies['importTexture']>
>[0]

function frame(
  sequence: number,
  generation = 3,
): NativeSharedVideoFrame {
  return {
    sessionId: 'voice',
    generation,
    trackId: 'screen',
    participantIdentity: 'remote',
    source: 'screen',
    local: false,
    sequence,
    width: 640,
    height: 360,
    timestampUs: sequence * 1_000,
    runtimeEpoch: 0,
    ntHandle: Buffer.alloc(8),
  }
}

function controllerHarness(remoteVideoFirstFrameTimeoutMs = 1_000) {
  let eventListener: ((event: MediaRuntimeEvent) => void) | null = null
  const request = vi.fn(async (_command: MediaRuntimeCommand) => undefined)
  const snapshot: NativeRuntimeSupervisorSnapshot = {
    runtime: 'media',
    status: 'ready',
    restartCount: 0,
    ready: {
      type: 'ready',
      runtime: 'media',
      contractVersion: 1,
      build: {
        electron: 'test',
        napi: '8',
        livekit: '1.3.0',
        commit: 'test',
      },
      capabilities: ['microphone', 'screen'],
    },
  }
  const supervisor = {
    onEvent(listener: (event: MediaRuntimeEvent) => void) {
      eventListener = listener
      return () => undefined
    },
    onStateChange() {
      return () => undefined
    },
    getSnapshot: () => snapshot,
    startEffect: () => Effect.succeed(snapshot.ready),
    retryEffect: () => Effect.succeed(snapshot.ready),
    request,
    requestEffect: (command: MediaRuntimeCommand) =>
      Effect.tryPromise({
        try: () => request(command),
        catch: (cause) => cause,
      }),
    shutdownEffect: () => Effect.void,
  } as unknown as NativeRuntimeSupervisor
  const controller = new NativeMediaController({
    supervisor,
    runtimeAvailable: () => true,
    getSelfWindowHwnd: () => '42',
    remoteVideoFirstFrameTimeoutMs,
  })
  eventListener?.({
    type: 'sessionLifecycle',
    sequence: 0,
    sessionId: 'voice',
    generation: 3,
    kind: 'voice',
    state: { status: 'running', sessionId: 'voice' },
  })
  return { controller, request }
}

function bridgeHarness(
  onPresentationStalled: SharedTextureBridgeDependencies[
    'onPresentationStalled'
  ],
  maxInFlight = 1,
) {
  const fenceCallbacks: Array<() => void> = []
  const release = vi.fn(async () => undefined)
  const imported = vi.fn(() => ({
    textureId: String(fenceCallbacks.length),
    release: vi.fn(),
    getVideoFrame: vi.fn(),
    subtle: {} as Electron.SharedTextureImportedSubtle,
  }))
  const bridge = new NativeSharedTextureBridge({
    getWindow: () => ({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        mainFrame: {},
      },
    }) as never,
    release,
    maxInFlight,
    stallTimeoutMs: 1_000,
    onPresentationStalled,
    importTexture: (options: ImportTextureOptions) => {
      fenceCallbacks.push(options.allReferencesReleased!)
      return imported() as never
    },
    sendTexture: vi.fn(async () => undefined),
  })
  return { bridge, fenceCallbacks, imported, release }
}

describe('remote screen presentation liveness', () => {
  it('recovers when decoded frames stop reaching the renderer', async () => {
    vi.useFakeTimers()
    try {
      const controller = controllerHarness()
      const presentation = bridgeHarness(
        (stalledFrame) =>
          controller.controller.recoverRemoteVideoDemand(
            stalledFrame.sessionId,
            stalledFrame.generation,
            stalledFrame.trackId,
          ),
      )
      await controller.controller.setRemoteVideoDemand(
        'voice',
        3,
        'screen',
        true,
      )
      controller.request.mockClear()

      const deliverDecodedFrame = async (sequence: number) => {
        const delivered = await presentation.bridge.deliver(frame(sequence))
        if (delivered) {
          controller.controller.markRemoteVideoFramePresented(
            'voice',
            3,
            'screen',
          )
        }
        return delivered
      }

      expect(await deliverDecodedFrame(1)).toBe(true)
      for (let sequence = 2; sequence <= 4; sequence += 1) {
        await vi.advanceTimersByTimeAsync(250)
        expect(await deliverDecodedFrame(sequence)).toBe(false)
      }
      await vi.advanceTimersByTimeAsync(250)

      expect(
        controller.request.mock.calls.some(
          ([command]) => command.type === 'retryRemoteVideo',
        ),
      ).toBe(true)
      expect(await deliverDecodedFrame(5)).toBe(true)
      expect(presentation.bridge.inFlightCount).toBe(2)
      expect(presentation.imported).toHaveBeenCalledTimes(2)
      await controller.controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
