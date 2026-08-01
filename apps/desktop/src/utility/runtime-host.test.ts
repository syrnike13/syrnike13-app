import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  NATIVE_RUNTIME_CONTRACT_VERSION,
  type NativeRuntimeEvent,
  type NativeRuntimeRequest,
} from '../main/native-runtime/contract'
import { NATIVE_RUNTIME_LIVEKIT_VERSION } from '../main/native-runtime/native-artifacts'
import {
  isAdvisoryNativeRuntimeEventCandidate,
  runNativeUtilityHost,
  shouldLogNativeRuntimeEvent,
} from './runtime-host'

describe('runNativeUtilityHost', () => {
  it('isolates malformed advisory telemetry from the control contract', () => {
    for (const type of [
      'screenBackendRestart',
      'stats',
      'microphoneMetrics',
      'activeSpeakers',
    ]) {
      expect(isAdvisoryNativeRuntimeEventCandidate({ type })).toBe(true)
    }

    expect(
      isAdvisoryNativeRuntimeEventCandidate({ type: 'sessionLifecycle' }),
    ).toBe(false)
    expect(isAdvisoryNativeRuntimeEventCandidate({})).toBe(false)
  })

  it('does not enqueue high-frequency video frames in diagnostic logs', () => {
    for (const type of [
      'remoteVideoFrame',
      'localScreenPreviewFrame',
      'localCameraPreviewFrame',
      'microphoneMetrics',
    ] satisfies NativeRuntimeEvent['type'][]) {
      expect(shouldLogNativeRuntimeEvent({ type } as NativeRuntimeEvent)).toBe(
        false,
      )
    }
    expect(
      shouldLogNativeRuntimeEvent({
        type: 'runtimeError',
      } as NativeRuntimeEvent),
    ).toBe(true)
  })

  it('ignores a requestless native reply without corrupting the host contract', async () => {
    const commitSha = 'a'.repeat(40)
    const nativeRoot = path.resolve('test-native-runtime')
    const nativeModulePath = path.join(nativeRoot, 'syrnike_media.node')
    const postedMessages: unknown[] = []
    let messageListener: ((event: { data: unknown }) => void) | undefined
    let emitFromRuntime:
      | ((event: Record<string, unknown>) => void)
      | undefined
    const dispatchedCommands: Array<Record<string, unknown>> = []
    const exit = vi.fn()
    const shutdown = vi.fn(async () => undefined)
    const addExtraParameter = vi.fn()

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
              dispatchedCommands.push(command)
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
      crashReporter: { addExtraParameter },
      exit,
    })

    expect(emitFromRuntime).toBeTypeOf('function')
    expect(addExtraParameter).toHaveBeenCalledWith(
      'native_runtime_kind',
      'media',
    )
    expect(addExtraParameter).toHaveBeenCalledWith(
      'native_runtime_commit',
      commitSha,
    )
    expect(addExtraParameter).toHaveBeenCalledWith(
      'native_host_stage',
      'ready',
    )
    expect(postedMessages).toEqual([
      expect.objectContaining({
        type: 'ready',
        runtime: 'media',
        contractVersion: NATIVE_RUNTIME_CONTRACT_VERSION,
      }),
    ])

    emitFromRuntime?.({
      type: 'screenBackendRestart',
      sequence: 1,
      sessionId: 'screen',
      generation: 1,
      backend: 'dxgi_gpu',
      reason: 'future_advisory_reason',
      count: 1,
    })
    expect(exit).not.toHaveBeenCalled()
    expect(shutdown).not.toHaveBeenCalled()
    expect(postedMessages).toHaveLength(1)

    messageListener?.({
      data: {
        type: 'request',
        requestId: 'camera-1',
        command: {
          type: 'connectCamera',
          sessionId: 'private-session',
          generation: 7,
          options: {
            participantIdentity: 'private-participant',
          },
        },
      } satisfies NativeRuntimeRequest,
    })
    expect(addExtraParameter).toHaveBeenCalledWith(
      'native_last_command',
      'connectCamera',
    )
    expect(addExtraParameter).toHaveBeenCalledWith(
      'native_camera_stage',
      'connect_dispatch',
    )
    expect(addExtraParameter).not.toHaveBeenCalledWith(
      expect.any(String),
      'private-participant',
    )

    const shutdownRequest: NativeRuntimeRequest = {
      type: 'request',
      requestId: 'shutdown-1',
      command: { type: 'shutdown' },
      diagnostic: {
        actionId: 'media-action-a',
        operationId: 'operation-a',
        revision: 5,
        hostEpoch: 3,
      },
    }
    messageListener?.({ data: shutdownRequest })
    expect(addExtraParameter).toHaveBeenCalledWith(
      'native_last_command',
      'shutdown',
    )
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
    expect(dispatchedCommands).toContainEqual(
      expect.objectContaining({
        requestId: 'shutdown-1',
        diagnostic: shutdownRequest.diagnostic,
      }),
    )
  })
})
