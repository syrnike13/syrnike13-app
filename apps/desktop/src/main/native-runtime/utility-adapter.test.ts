import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getAppPath: () => 'C:\\syrnike',
    getVersion: () => '0.5.1',
    isPackaged: false,
  },
  utilityProcess: { fork: vi.fn() },
}))

vi.stubGlobal('__DESKTOP_COMMIT_SHA__', 'a'.repeat(40))

import {
  createNativeDiagnosticLog,
  createNativeDiagnosticSession,
} from './diagnostic-log'
import { DESKTOP_RELEASE_CHANNEL } from '../desktop-app-identity'
import { BoundedByteTail, ElectronUtilityAdapter } from './utility-adapter'

class FakeUtilityProcess extends EventEmitter {
  pid = 42
  postMessage = vi.fn()
  kill = vi.fn()
  stderr = new Readable({ read() {} })
}

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('ElectronUtilityAdapter', () => {
  it('pipes and bounds native stderr while terminating an errored host exactly once', async () => {
    const child = new FakeUtilityProcess()
    const fork = vi.fn(() => child as any)
    const onExit = vi.fn()
    const adapter = new ElectronUtilityAdapter({
      runtime: 'media',
      utilityEntryPath: 'C:\\syrnike\\media-host.cjs',
      nativeModulePath: 'C:\\syrnike\\syrnike_media.node',
      fork,
    })

    adapter.start({ onMessage: vi.fn(), onExit })
    expect(fork.mock.calls[0]?.[2]).toMatchObject({
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    expect(fork.mock.calls[0]?.[2]?.env).toMatchObject({
      SYRNIKE_NATIVE_APP_VERSION: '0.5.1',
      SYRNIKE_NATIVE_CONTRACT_VERSION: '7',
      SYRNIKE_NATIVE_LIVEKIT_VERSION: '1.3.0',
      SYRNIKE_NATIVE_COMMIT_SHA: 'a'.repeat(40),
      SYRNIKE_NATIVE_RELEASE_CHANNEL: DESKTOP_RELEASE_CHANNEL,
      SYRNIKE_NATIVE_RUNTIME_KIND: 'media',
    })
    expect(fork.mock.calls[0]?.[2]?.env).not.toHaveProperty('PATH')

    child.stderr.emit('data', Buffer.from('fatal native failure\n'))
    child.emit('error', new Error('host transport failed'))
    child.emit('exit', 1)
    child.stderr.emit('data', Buffer.from('final detail'))
    child.stderr.push(null)

    expect(child.kill).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => {
      expect(onExit).toHaveBeenCalledTimes(1)
      expect(onExit).toHaveBeenCalledWith({
        code: null,
        error: expect.objectContaining({ message: 'Error: host transport failed' }),
        stderrBytesCaptured: 33,
        stderrBytesSeen: 33,
        stderrTruncated: false,
      })
    })
  })

  it('passes media diagnostic env vars only when a session is provided and logs transport events', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'syrnike-native-adapter-'))
    directories.push(directory)
    const session = createNativeDiagnosticSession({
      runtime: 'media',
      rootDir: directory,
      now: () => Date.parse('2026-07-10T12:00:00.000Z'),
      randomUUID: () => 'run-1',
    })
    const child = new FakeUtilityProcess()
    const fork = vi.fn(() => child as any)
    const adapter = new ElectronUtilityAdapter({
      runtime: 'media',
      utilityEntryPath: 'C:\\syrnike\\media-host.cjs',
      nativeModulePath: 'C:\\syrnike\\syrnike_media.node',
      diagnosticSession: session,
      fork,
    })

    adapter.start({ onMessage: vi.fn(), onExit: vi.fn() })
    adapter.postMessage({
      type: 'request',
      requestId: 'request-1',
      command: { type: 'shutdown' },
    })
    for (const type of [
      'remoteVideoFrame',
      'localScreenPreviewFrame',
      'localCameraPreviewFrame',
      'microphoneMetrics',
    ]) {
      child.emit('message', { type: 'event', event: { type } })
    }
    child.emit('message', {
      type: 'reply',
      requestId: 'frame-release',
      ok: true,
    })
    child.emit('message', { type: 'ready', contractVersion: 7, runtime: 'media' })
    adapter.kill()

    expect(fork.mock.calls[0]?.[2]?.env).toMatchObject({
      SYRNIKE_NATIVE_DIAGNOSTIC_RUN_ID: session.runId,
      SYRNIKE_NATIVE_UTILITY_LOG_PATH: session.paths.utilityPath,
      SYRNIKE_NATIVE_MEDIA_LOG_PATH: session.paths.nativePath,
    })

    await vi.waitFor(async () => {
      const lines = (await readFile(session.paths.electronMainPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(lines.map((line) => line.event)).toEqual([
        'transport_spawn',
        'transport_started',
        'transport_post',
        'transport_message',
        'transport_kill',
      ])
    })
  })

  it('does not inject diagnostic env vars for hotkey without a session', () => {
    const child = new FakeUtilityProcess()
    const fork = vi.fn(() => child as any)
    const adapter = new ElectronUtilityAdapter({
      runtime: 'hotkey',
      utilityEntryPath: 'C:\\syrnike\\hotkey-host.cjs',
      nativeModulePath: 'C:\\syrnike\\syrnike_hotkey.node',
      fork,
    })

    adapter.start({ onMessage: vi.fn(), onExit: vi.fn() })

    expect(fork.mock.calls[0]?.[2]?.env).not.toHaveProperty(
      'SYRNIKE_NATIVE_DIAGNOSTIC_RUN_ID',
    )
    expect(fork.mock.calls[0]?.[2]?.env).not.toHaveProperty(
      'SYRNIKE_NATIVE_UTILITY_LOG_PATH',
    )
    expect(fork.mock.calls[0]?.[2]?.env).not.toHaveProperty(
      'SYRNIKE_NATIVE_MEDIA_LOG_PATH',
    )
  })

  it('keeps one ordered main log alive across utility adapter restarts', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'syrnike-native-adapter-'))
    directories.push(directory)
    const session = createNativeDiagnosticSession({
      runtime: 'media',
      rootDir: directory,
      randomUUID: () => 'shared-run',
    })
    const diagnosticLog = createNativeDiagnosticLog({
      runtime: 'media',
      role: 'electron-main',
      runId: session.runId,
      directory: session.directory,
      latestPath: session.latestPath,
      filePath: session.paths.electronMainPath,
      paths: session.paths,
    })

    for (let restart = 0; restart < 2; restart += 1) {
      const child = new FakeUtilityProcess()
      const adapter = new ElectronUtilityAdapter({
        runtime: 'media',
        utilityEntryPath: 'C:\\syrnike\\media-host.cjs',
        nativeModulePath: 'C:\\syrnike\\syrnike_media.node',
        diagnosticSession: session,
        diagnosticLog,
        fork: () => child as any,
      })
      adapter.start({ onMessage: vi.fn(), onExit: vi.fn() })
      adapter.kill()
    }
    diagnosticLog.log('after_restart')
    await diagnosticLog.close()

    const lines = (await readFile(session.paths.electronMainPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(lines.map((line) => line.event)).toEqual([
      'transport_spawn',
      'transport_started',
      'transport_kill',
      'transport_spawn',
      'transport_started',
      'transport_kill',
      'after_restart',
    ])
    expect(lines.map((line) => line.data.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(new Set(lines.map((line) => line.data.run_id))).toEqual(
      new Set([session.runId]),
    )
  })

  it('stores the bounded stderr tail in the structured diagnostic log on exit', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'syrnike-native-adapter-'))
    directories.push(directory)
    const session = createNativeDiagnosticSession({
      runtime: 'media',
      rootDir: directory,
      randomUUID: () => 'stderr-run',
    })
    const child = new FakeUtilityProcess()
    const adapter = new ElectronUtilityAdapter({
      runtime: 'media',
      utilityEntryPath: 'C:\\syrnike\\media-host.cjs',
      nativeModulePath: 'C:\\syrnike\\syrnike_media.node',
      diagnosticSession: session,
      fork: () => child as any,
    })
    const onExit = vi.fn()

    adapter.start({ onMessage: vi.fn(), onExit })
    child.stderr.emit(
      'data',
      Buffer.from(`${'discarded'.repeat(3_000)}native-crash-tail`),
    )
    child.emit('exit', 3)

    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1))
    await vi.waitFor(async () => {
      const records = (await readFile(session.paths.electronMainPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      const exit = records.find((record) => record.event === 'transport_exit')
      expect(exit?.data.payload).toMatchObject({
        code: 3,
        stderrBytesCaptured: 16 * 1_024,
        stderrTruncated: true,
      })
      expect(
        (exit?.data.payload.stderrTailChunks as string[]).join(''),
      ).toContain('native-crash-tail')
    })
  })

  it('keeps stderr capture alive until a killed host finishes draining its pipe', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'syrnike-native-adapter-'))
    directories.push(directory)
    const session = createNativeDiagnosticSession({
      runtime: 'media',
      rootDir: directory,
      randomUUID: () => 'killed-stderr-run',
    })
    const child = new FakeUtilityProcess()
    const onExit = vi.fn()
    const adapter = new ElectronUtilityAdapter({
      runtime: 'media',
      utilityEntryPath: 'C:\\syrnike\\media-host.cjs',
      nativeModulePath: 'C:\\syrnike\\syrnike_media.node',
      diagnosticSession: session,
      fork: () => child as any,
    })

    adapter.start({ onMessage: vi.fn(), onExit })
    child.stderr.emit('data', Buffer.from('last native line before forced exit'))
    adapter.kill()
    child.emit('exit', 1)
    child.stderr.push(null)

    await vi.waitFor(async () => {
      const records = (await readFile(session.paths.electronMainPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      const exit = records.find((record) => record.event === 'transport_exit')
      expect(
        (exit?.data.payload.stderrTailChunks as string[]).join(''),
      ).toContain('last native line before forced exit')
    })
    expect(onExit).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 1,
        stderrBytesCaptured: 35,
      }),
    )
  })

  it('redacts stderr credentials before splitting the diagnostic tail', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'syrnike-native-adapter-'))
    directories.push(directory)
    const session = createNativeDiagnosticSession({
      runtime: 'media',
      rootDir: directory,
      randomUUID: () => 'stderr-redaction-run',
    })
    const child = new FakeUtilityProcess()
    const adapter = new ElectronUtilityAdapter({
      runtime: 'media',
      utilityEntryPath: 'C:\\syrnike\\media-host.cjs',
      nativeModulePath: 'C:\\syrnike\\syrnike_media.node',
      diagnosticSession: session,
      fork: () => child as any,
    })

    adapter.start({ onMessage: vi.fn(), onExit: vi.fn() })
    child.stderr.emit(
      'data',
      Buffer.from(`${'x'.repeat(4_089)} token=secret-value`),
    )
    child.emit('exit', 1)
    child.stderr.push(null)

    await vi.waitFor(async () => {
      const records = (await readFile(session.paths.electronMainPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      const exit = records.find((record) => record.event === 'transport_exit')
      const tail = (exit?.data.payload.stderrTailChunks as string[]).join('')
      expect(tail).toContain('token=[redacted]')
      expect(tail).not.toContain('secret-value')
    })
  })
})

describe('BoundedByteTail', () => {
  it('keeps only the newest bytes without losing the total seen count', () => {
    const tail = new BoundedByteTail(5)
    tail.append('1234')
    tail.append('567')
    expect(tail.snapshot()).toEqual({
      value: Buffer.from('34567'),
      bytesSeen: 7,
      truncated: true,
    })
  })
})
