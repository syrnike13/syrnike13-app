import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { MediaArtifactManifest } from '../main/media-runtime/media-artifacts'
import { MEDIA_LIFECYCLE_SCHEMA_SHA256 } from '../main/media-runtime/contract'
import { MEDIA_LIFECYCLE_CANONICAL_FIXTURES } from '../main/media-runtime/protocol.generated'
import { runMediaUtilityHost } from './media-host'

const COMMIT_SHA = 'b'.repeat(40)

function manifest(): MediaArtifactManifest {
  return {
    schemaVersion: 1,
    protocolVersion: 3,
    protocolSchemaSha256: MEDIA_LIFECYCLE_SCHEMA_SHA256,
    platform: 'win32',
    arch: 'x64',
    appVersion: '0.6.11',
    releaseChannel: 'stable',
    commitSha: COMMIT_SHA,
    electronVersion: process.versions.electron,
    napiVersion: 8,
    capabilities: ['lifecycle', 'control-v3', 'diagnostics-v2'],
    limits: {
      controlQueue: 16,
      eventQueue: 64,
      startDeadlineMs: 2_000,
      pingDeadlineMs: 1_000,
      shutdownDeadlineMs: 1_000,
      maxIdentifierLength: 256,
      maxRemoteVideoDemands: 64,
      maxDiagnosticMetrics: 16,
      maxDiagnosticFields: 16,
      maxRequestDeadlineMs: 5_000,
    },
    files: [
      { name: 'windows_media.node', sha256: 'a'.repeat(64) },
      { name: 'livekit.dll', sha256: 'b'.repeat(64) },
      { name: 'livekit_ffi.dll', sha256: 'c'.repeat(64) },
    ],
  }
}

function environment(mediaRoot: string): NodeJS.ProcessEnv {
  return {
    SYRNIKE_MEDIA_MODULE_PATH: path.join(mediaRoot, 'windows_media.node'),
    SYRNIKE_MEDIA_ROOT: mediaRoot,
    SYRNIKE_MEDIA_APP_VERSION: '0.6.11',
    SYRNIKE_MEDIA_RELEASE_CHANNEL: 'stable',
    SYRNIKE_MEDIA_PROTOCOL_VERSION: '3',
    SYRNIKE_MEDIA_COMMIT_SHA: COMMIT_SHA,
  }
}

describe('runMediaUtilityHost', () => {
  it('handshakes, pings, and shuts down a lifecycle-only addon', async () => {
    const mediaRoot = path.resolve('test-media-engine')
    const posted: unknown[] = []
    let onMessage: ((event: { data: unknown }) => void) | undefined
    let emit: ((event: unknown) => void) | undefined
    let emitDiagnostic: ((event: unknown) => void) | undefined
    const exit = vi.fn()

    await runMediaUtilityHost({
      parentPort: {
        on: (_event, listener) => {
          onMessage = listener
        },
        postMessage: (message) => posted.push(message),
      },
      environment: environment(mediaRoot),
      nativeModuleExists: () => true,
      verifyDistribution: () => manifest(),
      loadAddon: () => ({
        registerPublicEventCallback: (callback: (event: unknown) => void) => {
          emit = callback
          return true
        },
        registerDiagnosticEventCallback: (callback: (event: unknown) => void) => {
          emitDiagnostic = callback
          return true
        },
        handshake: () => ({
          protocolVersion: 3,
          engineState: 'running',
          build: {
            commit: COMMIT_SHA,
            napi: '8',
            protocolSchemaSha256: MEDIA_LIFECYCLE_SCHEMA_SHA256,
          },
        }),
        installCredentialLease: (lease: unknown) => ({
          type: 'credentialLeaseInstalled',
          leaseId: Reflect.get(lease as object, 'leaseId'),
        }),
        applyDesiredState: (desiredState: unknown) => ({
          type: 'desiredStateAccepted',
          acceptedRevision: Reflect.get(desiredState as object, 'revision'),
          disposition: 'accepted',
        }),
        querySnapshot: () => ({
          type: 'snapshot',
          snapshot: {
            engineState: 'running',
            acceptedRevision: null,
            desiredState: null,
            roomState: 'off',
            tracks: { microphone: 'off', camera: 'off', screen: 'off', output: 'off' },
          },
          unexpected: true,
        }),
        ping: () => ({ type: 'pong', engineState: 'running' }),
        shutdown: () => ({ type: 'shutdownComplete', engineState: 'stopped' }),
      }),
      registerShutdownSignals: () => undefined,
      exit,
      scheduleExit: (operation) => operation(),
    })

    expect(posted).toContainEqual({
      type: 'ready',
      protocolVersion: 3,
      engineState: 'running',
      build: {
        commit: COMMIT_SHA,
        napi: '8',
        protocolSchemaSha256: MEDIA_LIFECYCLE_SCHEMA_SHA256,
      },
    })

    emit?.({
      type: 'engineStateChanged',
      sequence: 3,
      previous: 'running',
      state: 'failed',
      failure: {
        code: 'fatal',
        message: 'authorization=secret',
        stage: 'engine',
        retryable: false,
      },
    })
    expect(posted).toContainEqual({
      type: 'event',
      protocolVersion: 3,
      event: expect.objectContaining({
        state: 'failed',
        failure: expect.objectContaining({
          message: 'authorization=[redacted]',
        }),
      }),
    })

    for (const message of MEDIA_LIFECYCLE_CANONICAL_FIXTURES.publicEventMessages) {
      emit?.(structuredClone(message.event))
      expect(posted).toContainEqual(message)
    }

    emitDiagnostic?.({
      sequence: 1,
      timestampMs: 1,
      component: 'engine',
      operation: 'ping',
      code: 'ok',
      metrics: [],
    })
    expect(posted).toContainEqual({
      type: 'diagnostic',
      protocolVersion: 3,
      event: expect.objectContaining({ code: 'ok' }),
    })

    onMessage?.({
      data: {
        type: 'request',
        protocolVersion: 3,
        requestId: 'ping-1',
        hostEpoch: 1,
        deadlineMs: 1_000,
        command: { type: 'ping' },
      },
    })
    await vi.waitFor(() =>
      expect(posted).toContainEqual({
        type: 'reply',
        protocolVersion: 3,
        requestId: 'ping-1',
        ok: true,
        result: { type: 'pong', engineState: 'running' },
      }),
    )

    const incompatible = {
      type: 'request',
      protocolVersion: 1,
      requestId: 'old-v1',
      hostEpoch: 1,
      deadlineMs: 1_000,
      command: { type: 'ping' },
    }
    onMessage?.({ data: incompatible })
    onMessage?.({ data: incompatible })
    await vi.waitFor(() =>
      expect(posted).toContainEqual({
        type: 'reply',
        protocolVersion: 3,
        requestId: 'old-v1',
        ok: false,
        failure: expect.objectContaining({ code: 'protocol_incompatible' }),
      }),
    )
    expect(
      posted.filter(
        (message) =>
          typeof message === 'object' && message !== null &&
          Reflect.get(message, 'requestId') === 'old-v1',
      ),
    ).toHaveLength(2)

    onMessage?.({
      data: {
        type: 'request',
        protocolVersion: 3,
        requestId: 'apply-1',
        hostEpoch: 1,
        deadlineMs: 1_000,
        command: {
          type: 'applyDesiredState',
          desiredState: {
            revision: 7,
            room: null,
            microphone: { state: 'off' },
            camera: { state: 'off' },
            screen: { state: 'off' },
            output: { state: 'off' },
            remoteVideoDemand: [],
          },
        },
      },
    })
    await vi.waitFor(() =>
      expect(posted).toContainEqual({
        type: 'reply',
        protocolVersion: 3,
        requestId: 'apply-1',
        ok: true,
        result: {
          type: 'desiredStateAccepted',
          acceptedRevision: 7,
          disposition: 'accepted',
        },
      }),
    )

    onMessage?.({
      data: {
        type: 'request',
        protocolVersion: 3,
        requestId: 'query-invalid-envelope',
        hostEpoch: 1,
        deadlineMs: 1_000,
        command: { type: 'querySnapshot' },
      },
    })
    await vi.waitFor(() =>
      expect(posted).toContainEqual({
        type: 'reply',
        protocolVersion: 3,
        requestId: 'query-invalid-envelope',
        ok: false,
        failure: expect.objectContaining({ code: 'media_snapshot_invalid' }),
      }),
    )

    onMessage?.({
      data: {
        type: 'request',
        protocolVersion: 3,
        requestId: 'shutdown-1',
        hostEpoch: 1,
        deadlineMs: 1_000,
        command: { type: 'shutdown' },
      },
    })
    onMessage?.({
      data: {
        type: 'request',
        protocolVersion: 3,
        requestId: 'shutdown-2',
        hostEpoch: 1,
        deadlineMs: 1_000,
        command: { type: 'shutdown' },
      },
    })
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(posted).toContainEqual({
      type: 'reply',
      protocolVersion: 3,
      requestId: 'shutdown-1',
      ok: true,
      result: { type: 'shutdownComplete', engineState: 'stopped' },
    })
    expect(posted).toContainEqual({
      type: 'reply',
      protocolVersion: 3,
      requestId: 'shutdown-2',
      ok: false,
      failure: expect.objectContaining({ code: 'engine_stopping' }),
    })
    for (const id of [
      'ping-1',
      'apply-1',
      'query-invalid-envelope',
      'shutdown-1',
      'shutdown-2',
    ]) {
      expect(
        posted.filter(
          (message) =>
            typeof message === 'object' &&
            message !== null &&
            Reflect.get(message, 'requestId') === id,
        ),
      ).toHaveLength(1)
    }
  })

  it('redacts diagnostic implementation values before forwarding them', async () => {
    const mediaRoot = path.resolve('test-media-engine')
    const posted: unknown[] = []
    let emitDiagnostic: ((event: unknown) => void) | undefined

    await runMediaUtilityHost({
      parentPort: {
        on: () => undefined,
        postMessage: (message) => posted.push(message),
      },
      environment: environment(mediaRoot),
      nativeModuleExists: () => true,
      verifyDistribution: () => manifest(),
      loadAddon: () => ({
        registerPublicEventCallback: () => true,
        registerDiagnosticEventCallback: (callback: (event: unknown) => void) => {
          emitDiagnostic = callback
          return true
        },
        installCredentialLease: vi.fn(),
        handshake: () => ({
          protocolVersion: 3,
          engineState: 'running',
          build: {
            commit: COMMIT_SHA,
            napi: '8',
            protocolSchemaSha256: MEDIA_LIFECYCLE_SCHEMA_SHA256,
          },
        }),
        ping: vi.fn(),
        applyDesiredState: vi.fn(),
        querySnapshot: vi.fn(),
        shutdown: vi.fn(),
      }),
      registerShutdownSignals: () => undefined,
    })

    emitDiagnostic?.({
      sequence: 1,
      timestampMs: 1,
      component: 'engine',
      operation: 'connect',
      code: 'trace',
      metrics: [],
      implementation: [{
        name: 'endpoint',
        value: 'Bearer abc.secret https://example.invalid/room',
      }],
    })

    expect(posted).toContainEqual({
      type: 'diagnostic',
      protocolVersion: 3,
      event: expect.objectContaining({
        implementation: [{
          name: 'endpoint',
          value: 'Bearer [redacted] [redacted-url]',
        }],
      }),
    })
  })

  it('rejects an incompatible addon handshake without dispatching commands', async () => {
    const mediaRoot = path.resolve('test-media-engine')
    const posted: unknown[] = []
    const exit = vi.fn()

    await runMediaUtilityHost({
      parentPort: {
        on: () => undefined,
        postMessage: (message) => posted.push(message),
      },
      environment: environment(mediaRoot),
      nativeModuleExists: () => true,
      verifyDistribution: () => manifest(),
      loadAddon: () => ({
        registerPublicEventCallback: () => true,
        registerDiagnosticEventCallback: () => true,
        installCredentialLease: vi.fn(),
        handshake: () => ({
          protocolVersion: 1,
          engineState: 'running',
          build: {
            commit: COMMIT_SHA,
            napi: '8',
            protocolSchemaSha256: MEDIA_LIFECYCLE_SCHEMA_SHA256,
          },
        }),
        ping: vi.fn(),
        applyDesiredState: vi.fn(),
        querySnapshot: vi.fn(),
        shutdown: vi.fn(),
      }),
      exit,
      scheduleExit: (operation) => operation(),
    })

    expect(posted).toEqual([
      expect.objectContaining({
        type: 'ready',
        protocolVersion: 0,
        engineState: 'failed',
        failure: expect.objectContaining({
          code: 'protocol_incompatible',
        }),
      }),
    ])
    expect(exit).toHaveBeenCalledWith(1)
  })
})
