import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { MediaArtifactManifest } from '../main/media-runtime/media-artifacts'
import { runMediaUtilityHost } from './media-host'

const COMMIT_SHA = 'b'.repeat(40)

function manifest(): MediaArtifactManifest {
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    platform: 'win32',
    arch: 'x64',
    appVersion: '0.6.11',
    releaseChannel: 'stable',
    commitSha: COMMIT_SHA,
    electronVersion: process.versions.electron,
    napiVersion: 8,
    capabilities: ['lifecycle'],
    limits: {
      controlQueue: 16,
      eventQueue: 64,
      startDeadlineMs: 2_000,
      pingDeadlineMs: 1_000,
      shutdownDeadlineMs: 1_000,
    },
    files: [{ name: 'windows_media.node', sha256: 'a'.repeat(64) }],
  }
}

function environment(mediaRoot: string): NodeJS.ProcessEnv {
  return {
    SYRNIKE_MEDIA_MODULE_PATH: path.join(mediaRoot, 'windows_media.node'),
    SYRNIKE_MEDIA_ROOT: mediaRoot,
    SYRNIKE_MEDIA_APP_VERSION: '0.6.11',
    SYRNIKE_MEDIA_RELEASE_CHANNEL: 'stable',
    SYRNIKE_MEDIA_PROTOCOL_VERSION: '1',
    SYRNIKE_MEDIA_COMMIT_SHA: COMMIT_SHA,
  }
}

describe('runMediaUtilityHost', () => {
  it('handshakes, pings, and shuts down a lifecycle-only addon', async () => {
    const mediaRoot = path.resolve('test-media-engine')
    const posted: unknown[] = []
    let onMessage: ((event: { data: unknown }) => void) | undefined
    let emit: ((event: unknown) => void) | undefined
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
        registerEventCallback: (callback: (event: unknown) => void) => {
          emit = callback
          return true
        },
        handshake: () => ({
          protocolVersion: 1,
          engineState: 'running',
          build: { commit: COMMIT_SHA, napi: '8' },
        }),
        ping: () => ({ ok: true, engineState: 'running' }),
        shutdown: () => ({ ok: true, engineState: 'stopped' }),
      }),
      registerShutdownSignals: () => undefined,
      exit,
      scheduleExit: (operation) => operation(),
    })

    expect(posted).toContainEqual({
      type: 'ready',
      protocolVersion: 1,
      engineState: 'running',
      build: { commit: COMMIT_SHA, napi: '8' },
    })

    emit?.({
      type: 'engineStateChanged',
      sequence: 3,
      previous: 'running',
      state: 'stopping',
    })
    expect(posted).toContainEqual({
      type: 'event',
      event: expect.objectContaining({ state: 'stopping' }),
    })

    onMessage?.({
      data: {
        type: 'request',
        requestId: 'ping-1',
        hostEpoch: 1,
        command: { type: 'ping' },
      },
    })
    await vi.waitFor(() =>
      expect(posted).toContainEqual({
        type: 'reply',
        requestId: 'ping-1',
        ok: true,
        result: { ok: true, engineState: 'running' },
      }),
    )

    onMessage?.({
      data: {
        type: 'request',
        requestId: 'shutdown-1',
        hostEpoch: 1,
        command: { type: 'shutdown' },
      },
    })
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(posted).toContainEqual({
      type: 'reply',
      requestId: 'shutdown-1',
      ok: true,
      result: { ok: true, engineState: 'stopped' },
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
        registerEventCallback: () => true,
        handshake: () => ({
          protocolVersion: 2,
          engineState: 'running',
          build: { commit: COMMIT_SHA, napi: '8' },
        }),
        ping: vi.fn(),
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
          code: 'media_handshake_incompatible',
        }),
      }),
    ])
    expect(exit).toHaveBeenCalledWith(1)
  })
})

