import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { NativeArtifactManifest } from '../main/native-runtime/native-artifacts'
import { runNativeUtilityHost } from './runtime-host'

const COMMIT_SHA = 'a'.repeat(40)

function createManifest(): NativeArtifactManifest {
  return {
    schemaVersion: 1,
    contractVersion: 10,
    platform: 'win32',
    arch: 'x64',
    appVersion: '0.6.11',
    releaseChannel: 'stable',
    commitSha: COMMIT_SHA,
    electronVersion: process.versions.electron ?? '',
    napiVersion: 8,
    capabilities: ['hotkeys', 'overlay'],
    files: [],
  }
}

describe('runNativeUtilityHost', () => {
  it('starts a hook-only host and forwards typed requests and replies', async () => {
    const nativeRoot = path.resolve('test-native-runtime')
    const nativeModulePath = path.join(nativeRoot, 'syrnike_hotkey.node')
    const posted: unknown[] = []
    let onMessage: ((event: { data: unknown }) => void) | undefined
    const dispatch = vi.fn()

    await runNativeUtilityHost('hotkey', {
      parentPort: {
        on: (_event, listener) => {
          onMessage = listener
        },
        postMessage: (message) => posted.push(message),
      },
      environment: {
        SYRNIKE_NATIVE_MODULE_PATH: nativeModulePath,
        SYRNIKE_NATIVE_ROOT: nativeRoot,
        SYRNIKE_NATIVE_APP_VERSION: '0.6.11',
        SYRNIKE_NATIVE_RELEASE_CHANNEL: 'stable',
        SYRNIKE_NATIVE_CONTRACT_VERSION: '10',
        SYRNIKE_NATIVE_COMMIT_SHA: COMMIT_SHA,
      },
      nativeModuleExists: () => true,
      verifyDistribution: () => createManifest(),
      loadAddon: () => ({
        getRuntimeInfo: () => ({
          runtime: 'hotkey',
          contractVersion: 10,
          capabilities: ['hotkeys'],
          commit: COMMIT_SHA,
          napi: '8',
        }),
        createHotkeyRuntime: (
          emit: (event: Record<string, unknown>) => void,
        ) => ({
          ready: () => undefined,
          dispatch: (command: Record<string, unknown>) => {
            dispatch(command)
            emit({
              type: 'reply',
              requestId: command.requestId,
              ok: true,
              result: { accepted: true },
            })
          },
          shutdown: () => undefined,
        }),
      }),
      registerShutdownSignals: () => undefined,
    })

    expect(posted[0]).toMatchObject({
      type: 'ready',
      contractVersion: 10,
      runtime: 'hotkey',
      capabilities: ['hotkeys'],
    })

    onMessage?.({
      data: {
        type: 'request',
        requestId: 'request-1',
        lane: 'hotkey',
        hostEpoch: 1,
        command: { type: 'startHotkeys' },
      },
    })

    expect(dispatch).toHaveBeenCalledWith({
      type: 'startHotkeys',
      requestId: 'request-1',
      lane: 'hotkey',
      hostEpoch: 1,
      diagnostic: undefined,
    })
    expect(posted[1]).toEqual({
      type: 'reply',
      requestId: 'request-1',
      ok: true,
      result: { accepted: true },
    })
  })

  it('rejects a module path outside the verified native root', async () => {
    const nativeRoot = path.resolve('test-native-runtime')
    const posted: unknown[] = []
    const loadAddon = vi.fn()

    await runNativeUtilityHost('hotkey', {
      parentPort: {
        on: () => undefined,
        postMessage: (message) => posted.push(message),
      },
      environment: {
        SYRNIKE_NATIVE_MODULE_PATH: path.resolve(
          'other-native-runtime',
          'syrnike_hotkey.node',
        ),
        SYRNIKE_NATIVE_ROOT: nativeRoot,
      },
      nativeModuleExists: () => true,
      loadAddon,
    })

    expect(loadAddon).not.toHaveBeenCalled()
    expect(posted).toEqual([
      expect.objectContaining({
        type: 'ready',
        contractVersion: 0,
        runtime: 'hotkey',
        capabilities: [],
      }),
    ])
  })
})
