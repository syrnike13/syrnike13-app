import { mkdir, mkdtemp, readFile, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createNativeDiagnosticLog,
  createNativeDiagnosticSession,
  pruneNativeDiagnosticSessions,
} from './diagnostic-log'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('native diagnostic log', () => {
  it('writes latest metadata and redacts sensitive payload fields', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'syrnike-native-diagnostic-'))
    directories.push(rootDir)
    const session = createNativeDiagnosticSession({
      runtime: 'media',
      rootDir,
      now: () => Date.parse('2026-07-10T12:00:00.000Z'),
      randomUUID: () => 'run-1',
    })
    const log = createNativeDiagnosticLog({
      runtime: 'media',
      role: 'electron-main',
      runId: session.runId,
      directory: session.directory,
      latestPath: session.latestPath,
      filePath: session.paths.electronMainPath,
      paths: session.paths,
      now: () => Date.parse('2026-07-10T12:00:01.000Z'),
    })

    log.log('transport_post', {
      requestId: 'request-1',
      command: {
        type: 'connectMicrophone',
        options: {
          livekit: {
            url: 'wss://voice.example/room',
            token: 'secret-token',
            participantIdentity: 'user:123',
          },
          preferredDevice: 'usb-mic',
          devices: [{ label: 'Private microphone name', id: 'default' }],
        },
      },
      processPath: 'C:\\secret\\runtime.exe',
      nested: [{ authorization: 'Bearer abc' }, 'https://voice.example/room'],
      message:
        'identity=user:123 roomName=secret-room deviceId=usb-mic C:\\Users\\Alice\\runtime.dll',
    })

    await log.close()

    const latest = JSON.parse(await readFile(session.latestPath, 'utf8'))
    expect(latest).toMatchObject({
      runtime: 'media',
      runId: session.runId,
      directoryName: path.basename(session.directory),
      files: {
        electronMain: 'electron-main.jsonl',
        utility: 'utility.jsonl',
        native: 'native.jsonl',
      },
    })

    const lines = (await readFile(session.paths.electronMainPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      schema: 'syrnike.diagnostic',
      version: 1,
      record_type: 'event',
      source: 'electron-main',
      event: 'transport_post',
      timestamp_ms: Date.parse('2026-07-10T12:00:01.000Z'),
      data: {
        runtime: 'media',
        run_id: session.runId,
        sequence: 1,
        pid: expect.any(Number),
        monotonic_ms: expect.any(Number),
      },
    })
    expect(lines[0].data.payload).toEqual({
      requestId: 'request-1',
      command: {
        type: 'connectMicrophone',
        options: {
          livekit: {},
        },
      },
      nested: [{}, '[redacted-url]'],
      message:
        'identity=[redacted] roomName=[redacted] deviceId=[redacted] [redacted-path]',
    })
  })

  it('flushes queued writes and ignores late writes after close', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'syrnike-native-diagnostic-'))
    directories.push(rootDir)
    const session = createNativeDiagnosticSession({
      runtime: 'media',
      rootDir,
      randomUUID: () => 'run-2',
    })
    const log = createNativeDiagnosticLog({
      runtime: 'media',
      role: 'utility',
      runId: session.runId,
      directory: session.directory,
      filePath: session.paths.utilityPath,
    })

    log.log('utility_ready', { ok: true })
    await log.flush()
    await log.close()
    log.log('late_write', { ignored: true })

    const lines = (await readFile(session.paths.utilityPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(lines.map((line) => line.event)).toEqual(['utility_ready'])
  })

  it('removes diagnostic sessions older than seven days', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'syrnike-native-diagnostic-'))
    directories.push(rootDir)
    const oldDirectory = path.join(rootDir, 'native-media-old')
    const recentDirectory = path.join(rootDir, 'native-media-recent')
    await Promise.all([mkdir(oldDirectory), mkdir(recentDirectory)])
    const now = Date.parse('2026-07-10T12:00:00.000Z')
    const oldTime = new Date(now - 8 * 24 * 60 * 60 * 1_000)
    const recentTime = new Date(now - 2 * 24 * 60 * 60 * 1_000)
    await utimes(oldDirectory, oldTime, oldTime)
    await utimes(recentDirectory, recentTime, recentTime)

    await pruneNativeDiagnosticSessions(rootDir, now)

    await expect(stat(oldDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(recentDirectory)).resolves.toBeDefined()
  })
})
