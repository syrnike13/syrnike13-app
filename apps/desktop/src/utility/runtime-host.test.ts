import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  NATIVE_RUNTIME_CONTRACT_VERSION,
  type NativeRuntimeRequest,
} from '../main/native-runtime/contract'
import { NATIVE_RUNTIME_LIVEKIT_VERSION } from '../main/native-runtime/native-artifacts'
import { runNativeUtilityHost } from './runtime-host'

describe('runNativeUtilityHost', () => {
  it('ignores a requestless native reply without corrupting the host contract', async () => {
    const commitSha = 'a'.repeat(40)
    const nativeRoot = path.resolve('test-native-runtime')
    const nativeModulePath = path.join(nativeRoot, 'syrnike_media.node')
    const postedMessages: unknown[] = []
    let messageListener: ((event: { data: unknown }) => void) | undefined
    let emitFromRuntime:
      | ((event: Record<string, unknown>) => void)
      | undefined
    const exit = vi.fn()
    const shutdown = vi.fn(async () => undefined)

    await runNativeUtilityHost('media', {
      parentPort: {
        on: (_event, listener) => {
          messageListener = listener
        },
        postMessage: (message) => {
          postedMessages.push(message)
        },
      },
      environment: {
        SYRNIKE_NATIVE_MODULE_PATH: nativeModulePath,
        SYRNIKE_NATIVE_ROOT: nativeRoot,
        SYRNIKE_NATIVE_APP_VERSION: '0.6.3',
        SYRNIKE_NATIVE_RELEASE_CHANNEL: 'stable',
        SYRNIKE_NATIVE_CONTRACT_VERSION: String(
          NATIVE_RUNTIME_CONTRACT_VERSION,
        ),
        SYRNIKE_NATIVE_LIVEKIT_VERSION: NATIVE_RUNTIME_LIVEKIT_VERSION,
        SYRNIKE_NATIVE_COMMIT_SHA: commitSha,
      },
      nativeModuleExists: () => true,
      verifyDistribution: (_root, expected) => ({
        schemaVersion: 1,
        contractVersion: expected.contractVersion,
        platform: 'win32',
        arch: 'x64',
        appVersion: expected.appVersion,
        releaseChannel: expected.releaseChannel,
        commitSha: expected.commitSha,
        electronVersion: expected.electronVersion,
        napiVersion: expected.minimumNapiVersion,
        liveKitVersion: expected.liveKitVersion,
        files: [],
      }),
      loadAddon: () => ({
        getRuntimeInfo: () => ({
          runtime: 'media',
          contractVersion: NATIVE_RUNTIME_CONTRACT_VERSION,
          capabilities: [
            'microphone',
            'screen',
            'screenAudio',
            'preview',
            'queries',
            'remoteVideo',
            'localScreenPreview',
            'localCameraPreview',
          ],
          commit: commitSha,
          napi: process.versions.napi,
          livekit: NATIVE_RUNTIME_LIVEKIT_VERSION,
        }),
        createMediaRuntime: (emit) => {
          emitFromRuntime = emit
          emit({
            type: 'reply',
            ok: false,
            error: {
              code: 'internal',
              message: 'legacy requestless reply',
            },
          })
          return {
            dispatch: (command) => {
              if (command.type !== 'shutdown') return
              emit({
                type: 'reply',
                requestId: command.requestId,
                ok: true,
              })
            },
            shutdown,
          }
        },
      }),
      registerShutdownSignals: () => undefined,
      exit,
    })

    expect(emitFromRuntime).toBeTypeOf('function')
    expect(postedMessages).toEqual([
      expect.objectContaining({
        type: 'ready',
        runtime: 'media',
        contractVersion: NATIVE_RUNTIME_CONTRACT_VERSION,
      }),
    ])

    const shutdownRequest: NativeRuntimeRequest = {
      type: 'request',
      requestId: 'shutdown-1',
      command: { type: 'shutdown' },
    }
    messageListener?.({ data: shutdownRequest })
    await vi.waitFor(() => {
      expect(shutdown).toHaveBeenCalledOnce()
      expect(exit).toHaveBeenCalledWith(0)
    })
    expect(postedMessages).toHaveLength(2)
    expect(postedMessages[1]).toEqual({
      type: 'reply',
      requestId: 'shutdown-1',
      ok: true,
    })
  })
})
