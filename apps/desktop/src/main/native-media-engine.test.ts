import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
  },
  ipcMain: {
    handle: vi.fn(),
  },
}))

describe('native media engine entrypoint', () => {
  it('exports the media engine IPC registrar', async () => {
    const module = await import('./native-media-engine')

    expect(module.registerNativeMediaEngineIpc).toEqual(expect.any(Function))
  })

  it('registers generic media session start IPC', async () => {
    const { ipcMain } = await import('electron')
    const { IPC } = await import('@syrnike13/platform')
    const { registerNativeMediaEngineIpc } = await import('./native-media-engine')

    registerNativeMediaEngineIpc(() => null)

    expect(ipcMain.handle).toHaveBeenCalledWith(
      IPC.mediaStartSession,
      expect.any(Function),
    )
    expect(ipcMain.handle).not.toHaveBeenCalledWith(
      expect.stringContaining('start-screen-share'),
      expect.any(Function),
    )
  })

  it('builds a capability snapshot for the native media engine', async () => {
    const { buildNativeMediaEngineSnapshot } = await import('./native-media-engine')

    expect(
      buildNativeMediaEngineSnapshot({
        platform: 'win32',
        helperAvailable: true,
        helperRunning: false,
        activeSession: null,
        lastError: null,
      }),
    ).toEqual({
      status: 'idle',
      engine: {
        available: true,
        helper: {
          available: true,
          running: false,
        },
        capabilities: {
          screen: true,
          systemAudio: true,
          microphone: false,
          camera: false,
        },
        activeSessions: [],
        lastError: null,
      },
    })
  })

  it('reports microphone capability when only the native voice helper exists', async () => {
    const { buildNativeMediaEngineSnapshot } = await import('./native-media-engine')

    expect(
      buildNativeMediaEngineSnapshot({
        platform: 'win32',
        helperAvailable: false,
        microphoneHelperAvailable: true,
        helperRunning: false,
        activeSession: null,
        lastError: null,
      }),
    ).toEqual({
      status: 'idle',
      engine: {
        available: true,
        helper: {
          available: true,
          running: false,
        },
        capabilities: {
          screen: false,
          systemAudio: false,
          microphone: true,
          camera: false,
        },
        activeSessions: [],
        lastError: null,
      },
    })
  })

  it('includes active session and last error in the media engine snapshot', async () => {
    const { buildNativeMediaEngineSnapshot } = await import('./native-media-engine')

    expect(
      buildNativeMediaEngineSnapshot({
        platform: 'win32',
        helperAvailable: true,
        helperRunning: true,
        activeSession: {
          sessionId: 'session-1',
          port: 55123,
        },
        lastError: 'previous failure',
        status: { status: 'running', sessionId: 'session-1', port: 55123 },
      }),
    ).toMatchObject({
      status: 'running',
      sessionId: 'session-1',
      port: 55123,
      engine: {
        available: true,
        helper: {
          available: true,
          running: true,
        },
        activeSessions: [
          {
            kind: 'screen',
            sessionId: 'session-1',
            status: 'running',
            port: 55123,
          },
        ],
        lastError: 'previous failure',
      },
    })
  })

  it('includes session audio in the media engine snapshot', async () => {
    const { buildNativeMediaEngineSnapshot } = await import('./native-media-engine')

    expect(
      buildNativeMediaEngineSnapshot({
        platform: 'win32',
        helperAvailable: true,
        helperRunning: true,
        activeSession: {
          sessionId: 'session-1',
          port: 55123,
          audio: {
            mode: 'system_exclude',
            port: 55124,
          },
        },
        lastError: null,
        status: { status: 'running', sessionId: 'session-1', port: 55123 },
      }),
    ).toMatchObject({
      engine: {
        activeSessions: [
          {
            sessionId: 'session-1',
            audio: {
              mode: 'system_exclude',
              port: 55124,
            },
          },
        ],
      },
    })
  })

  it('builds microphone start command from session options', async () => {
    const { buildNativeMediaStartCommand } = await import('./native-media-engine')

    expect(
      buildNativeMediaStartCommand(
        {
          kind: 'microphone',
          deviceId: 'default',
          sampleRate: 48_000,
          channels: 1,
          echoCancellation: true,
          inputVolume: 1.25,
          livekit: {
            url: 'wss://livekit.example',
            token: 'native-livekit-token',
            participantIdentity: 'user-1:desktop-native',
          },
        },
        'mic-session-1',
        () => null,
      ),
    ).toMatchObject({
      cmd: 'start',
      sessionId: 'mic-session-1',
      sessionKind: 'microphone',
      deviceId: 'default',
      sampleRate: 48_000,
      channels: 1,
      echoCancellation: true,
      inputVolume: 1.25,
      livekit: {
        url: 'wss://livekit.example',
        token: 'native-livekit-token',
        participantIdentity: 'user-1:desktop-native',
      },
    })
  })

  it('builds screen start command with native LiveKit credentials', async () => {
    const { buildNativeMediaStartCommand } = await import('./native-media-engine')

    expect(
      buildNativeMediaStartCommand(
        {
          kind: 'screen',
          sourceId: 'game:1234',
          width: 1920,
          height: 1080,
          fps: 60,
          bitrate: 8_000_000,
          audio: { requested: true },
          livekit: {
            url: 'wss://livekit.example',
            token: 'native-screen-token',
            participantIdentity: 'user-1:desktop-native',
          },
        },
        'screen-session-1',
        () => null,
      ),
    ).toMatchObject({
      cmd: 'start',
      sessionId: 'screen-session-1',
      sessionKind: 'screen',
      sourceId: 'game:1234',
      width: 1920,
      height: 1080,
      fps: 60,
      bitrate: 8_000_000,
      audio: true,
      excludeProcessId: process.pid,
      livekit: {
        url: 'wss://livekit.example',
        token: 'native-screen-token',
        participantIdentity: 'user-1:desktop-native',
      },
    })
  })

  it('builds screen preflight command with audio and process exclusion contract', async () => {
    const { buildScreenSharePreflightCommand } = await import(
      './native-media-engine'
    )
    const getNativeWindowHandle = vi.fn(() => {
      const handle = Buffer.alloc(8)
      handle.writeBigUInt64LE(1234n)
      return handle
    })

    expect(
      buildScreenSharePreflightCommand(
        {
          kind: 'screen',
          sourceId: 'window:5678',
          width: 1920,
          height: 1080,
          fps: 60,
          bitrate: 8_000_000,
          audio: { requested: true },
          livekit: {
            url: 'wss://livekit.example',
            token: 'native-screen-token',
            participantIdentity: 'user-1:desktop-native',
          },
        },
        () =>
          ({
            isDestroyed: () => false,
            getNativeWindowHandle,
          }) as never,
      ),
    ).toMatchObject({
      cmd: 'probe_screen_share',
      sessionId: 'preflight',
      sessionKind: 'screen',
      sourceId: 'window:5678',
      width: 1920,
      height: 1080,
      fps: 60,
      bitrate: 8_000_000,
      durationMs: 1000,
      audio: true,
      excludeProcessId: process.pid,
      selfWindowHwnd: '1234',
    })
  })

  it('preflights native screen share before starting LiveKit publishing', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./native-media-engine.ts', import.meta.url)),
      'utf8',
    )

    expect(source).toContain('buildScreenSharePreflightCommand')
    expect(source).toContain("cmd: 'probe_screen_share'")
    expect(source).toContain('await runNativeScreenSharePreflight(options, getWindow)')
    expect(source).toContain("status: 'error'")
    expect(source).toContain('Native screen share preflight failed')
  })

  it('does not synthesize running lifecycle state during sidecar reconnect', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./native-media-engine.ts', import.meta.url)),
      'utf8',
    )
    const reconnectBody = source.match(
      /async function attemptSidecarReconnect[\s\S]*?\r?\n}\r?\n\r?\nasync function handleSidecarFailure/,
    )?.[0]

    expect(reconnectBody).toBeDefined()
    expect(reconnectBody).not.toContain("status: 'running'")
  })

  it('does not expose a renderer media relay for native sessions', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./native-media-engine.ts', import.meta.url)),
      'utf8',
    )

    expect(source).not.toContain('mediaStreamChunk')
    expect(source).not.toContain('mediaStreamAudioChunk')
    expect(source).not.toContain('mediaReadSharedFrame')
    expect(source).not.toContain('forwardStreamAudioPayload')
    expect(source).not.toContain('attachStreamRelay')
  })

  it('forwards native published track telemetry through media stats events', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./native-media-engine.ts', import.meta.url)),
      'utf8',
    )
    const trackPublishedBranch = source.match(
      /if \(event\.type === 'track_published'\) \{[\s\S]*?console\.info/,
    )?.[0]

    expect(trackPublishedBranch).toBeDefined()
    expect(trackPublishedBranch).toContain("event.kind === 'video'")
    expect(trackPublishedBranch).toContain("event.kind === 'audio'")
    expect(trackPublishedBranch).toContain('publishedVideo')
    expect(trackPublishedBranch).toContain('publishedAudio')
    expect(trackPublishedBranch).toContain('emitMediaEngineStats')
  })

  it('removes stale Rust capture helper from packaged native resources', () => {
    const source = readFileSync(
      fileURLToPath(
        new URL('../../scripts/build-native-voice-win.mjs', import.meta.url),
      ),
      'utf8',
    )

    expect(source).toContain('syrnike-native-voice-win.exe')
    expect(source).toContain('syrnike-capture-helper-win.exe')
    expect(source).toContain('rmSync(staleCaptureExe)')
  })

  it('forwards native sidecar error events to renderer state listeners', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./native-media-engine.ts', import.meta.url)),
      'utf8',
    )
    const errorBranch = source.match(
      /if \(event\.type === 'error'\) \{[\s\S]*?pendingStartResolver = null[\s\S]*?return\s*\}/,
    )?.[0]

    expect(errorBranch).toBeDefined()
    expect(errorBranch).toContain('emitMediaEngineState')
    expect(errorBranch).toContain("status: 'error'")
  })

  it('passes the desktop window handle when listing native display sources', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./native-media-engine.ts', import.meta.url)),
      'utf8',
    )
    const listBody = source.match(
      /export async function listNativeDisplaySources[\s\S]*?\r?\n}\r?\n\r?\nasync function waitForSidecarReady/,
    )?.[0]

    expect(listBody).toBeDefined()
    expect(listBody).toContain('selfWindowHwnd')
    expect(listBody).toContain("cmd: 'list_screen_sources'")
  })
})
