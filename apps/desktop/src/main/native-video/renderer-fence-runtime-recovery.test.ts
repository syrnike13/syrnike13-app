import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import {
  NATIVE_RUNTIME_CONTRACT_VERSION,
  type NativeRuntimeReady,
  type NativeRuntimeRequest,
} from '../native-runtime/contract'
import { NativeRuntimeSupervisor } from '../native-runtime/runtime-supervisor'
import type {
  NativeRuntimeAdapter,
  NativeRuntimeAdapterCallbacks,
} from '../native-runtime/utility-adapter'
import {
  NativeSharedTextureBridge,
  type NativeSharedVideoFrame,
  type NativeSharedVideoRelease,
  type SharedTextureBridgeDependencies,
} from './shared-texture-bridge'

type ImportTextureOptions = Parameters<
  NonNullable<SharedTextureBridgeDependencies['importTexture']>
>[0]

const READY: NativeRuntimeReady = {
  type: 'ready',
  contractVersion: NATIVE_RUNTIME_CONTRACT_VERSION,
  runtime: 'media',
  capabilities: ['microphone'],
  build: {},
}

class FakeAdapter implements NativeRuntimeAdapter {
  readonly pid = 42
  callbacks: NativeRuntimeAdapterCallbacks | null = null
  requests: NativeRuntimeRequest[] = []
  killed = false

  start(callbacks: NativeRuntimeAdapterCallbacks) {
    this.callbacks = callbacks
  }

  postMessage(message: NativeRuntimeRequest) {
    this.requests.push(message)
  }

  kill() {
    this.killed = true
  }

  ready() {
    this.callbacks?.onMessage(READY)
  }

  replyByType(type: string, result: unknown) {
    const request = this.requests.find((candidate) =>
      candidate.command.type === type
    )
    if (!request) throw new Error(`missing ${type} request`)
    this.callbacks?.onMessage({
      type: 'reply',
      requestId: request.requestId,
      ok: true,
      result,
    })
  }
}

function frame(sequence: number, runtimeEpoch: number): NativeSharedVideoFrame {
  return {
    sessionId: 'voice',
    generation: 7,
    trackId: 'remote-4k',
    participantIdentity: 'viewer',
    source: 'camera',
    local: false,
    sequence,
    width: 3840,
    height: 2160,
    timestampUs: runtimeEpoch * 1_000_000 + sequence * 1_000,
    runtimeEpoch,
    ntHandle: Buffer.alloc(8),
  }
}

describe('renderer fence runtime recovery', () => {
  it('reloads, recycles the exact epoch, resumes fresh, and bounds a voice-lane timeout', async () => {
    vi.useFakeTimers()
    try {
      const adapters: FakeAdapter[] = []
      const scheduledRestarts: Array<() => void> = []
      const supervisor = new NativeRuntimeSupervisor({
        runtime: 'media',
        createAdapter: () => {
          const adapter = new FakeAdapter()
          adapters.push(adapter)
          return adapter
        },
        probeTimeoutMs: 2_500,
        schedule: (callback) => {
          scheduledRestarts.push(callback)
          return scheduledRestarts.length as unknown as ReturnType<
            typeof setTimeout
          >
        },
      })
      const start = supervisor.start()
      adapters[0]!.ready()
      await start

      const fenceCallbacks: Array<() => void> = []
      const release = vi.fn((released: NativeSharedVideoRelease) =>
        Effect.runPromise(supervisor.releaseRendererLeaseEffect({
          type: 'releaseRemoteVideoFrame',
          sessionId: released.sessionId,
          generation: released.generation,
          trackId: released.trackId,
          sequence: released.sequence,
        })).then(() => undefined)
      )
      let bridge!: NativeSharedTextureBridge
      bridge = new NativeSharedTextureBridge({
        getWindow: () => ({
          isDestroyed: () => false,
          webContents: {
            isDestroyed: () => false,
            mainFrame: { isDestroyed: () => false, detached: false },
          },
        }) as never,
        release,
        maxInFlight: 3,
        maxRetainedBytes: 256 * 1024 * 1024,
        stallTimeoutMs: 1_000,
        retiredFenceReloadMs: 1_000,
        retiredFenceRecycleMs: 2_000,
        importTexture: (options: ImportTextureOptions) => {
          fenceCallbacks.push(options.allReferencesReleased!)
          return {
            textureId: String(fenceCallbacks.length),
            release: vi.fn(),
            getVideoFrame: vi.fn(),
            subtle: {} as Electron.SharedTextureImportedSubtle,
          } as never
        },
        sendTexture: vi.fn(async () => undefined),
        onPresentationStalled: (_stalled, reason) => {
          if (reason === 'retired-fence-deadline') bridge.rendererReloaded()
          if (reason === 'retired-fence-recycle') {
            supervisor.recycleRendererFenceOwner(_stalled.runtimeEpoch)
          }
        },
      })
      bridge.runtimeReplaced(1)
      const stopState = supervisor.onStateChange((snapshot) => {
        if (snapshot.hostEpoch !== undefined) {
          bridge.runtimeReplaced(snapshot.hostEpoch)
        }
      })

      for (let sequence = 1; sequence <= 3; sequence += 1) {
        expect(await bridge.deliver(frame(sequence, 1))).toBe(true)
      }
      expect(bridge.retainedByteCount).toBe(3 * 3840 * 2160 * 4)
      await vi.advanceTimersByTimeAsync(3_000)
      expect(adapters[0]!.killed).toBe(true)
      expect(scheduledRestarts).toHaveLength(1)

      scheduledRestarts[0]!()
      expect(adapters).toHaveLength(2)
      adapters[1]!.ready()
      await vi.waitFor(() => {
        expect(supervisor.getSnapshot()).toMatchObject({
          status: 'ready',
          hostEpoch: 2,
        })
      })

      for (const releaseFence of fenceCallbacks.splice(0)) releaseFence()
      await vi.runAllTicks()
      expect(release).not.toHaveBeenCalled()
      expect(bridge.inFlightCount).toBe(0)
      expect(bridge.retainedByteCount).toBe(0)

      const fresh = frame(1, 2)
      expect(await bridge.deliver(fresh)).toBe(true)
      expect(fresh.timestampUs).toBeGreaterThan(frame(3, 1).timestampUs)
      fenceCallbacks[0]!()
      await vi.runAllTicks()
      expect(release).toHaveBeenCalledTimes(1)

      await vi.waitFor(() => {
        expect(adapters[1]!.requests.map(({ command }) => command.type)).toEqual([
          'releaseRemoteVideoFrame',
        ])
      })
      await vi.advanceTimersByTimeAsync(2_000)
      await vi.waitFor(() => {
        expect(adapters[1]!.requests.map(({ command }) => command.type)).toEqual([
          'releaseRemoteVideoFrame',
          'probeVoiceControl',
        ])
      })
      adapters[1]!.replyByType('probeVoiceControl', {
        state: 'busy',
        hostEpoch: 2,
        queueDepth: 1,
        queueCapacity: 64,
      })
      await vi.waitFor(() => {
        expect(adapters[1]!.requests.map(({ command }) => command.type)).toEqual([
          'releaseRemoteVideoFrame',
          'probeVoiceControl',
          'releaseRemoteVideoFrame',
        ])
      })
      await vi.advanceTimersByTimeAsync(2_000)
      expect(adapters[1]!.killed).toBe(true)
      expect(bridge.inFlightCount).toBe(0)
      expect(bridge.retainedByteCount).toBe(0)

      stopState()
      bridge.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
