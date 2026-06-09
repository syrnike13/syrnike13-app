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
    expect(ipcMain.handle).toHaveBeenCalledWith(
      IPC.mediaSetMicrophoneMuted,
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

  it('includes microphone and screen sessions in one media engine snapshot', async () => {
    const { buildNativeMediaEngineSnapshot } = await import('./native-media-engine')

    expect(
      buildNativeMediaEngineSnapshot({
        platform: 'win32',
        helperAvailable: true,
        microphoneHelperAvailable: true,
        helperRunning: true,
        activeSession: null,
        activeSessions: [
          {
            sessionId: 'mic-session-1',
            audio: { mode: 'microphone', sampleRate: 48_000, channels: 1 },
            startOptions: { kind: 'microphone' },
          },
          {
            sessionId: 'screen-session-1',
            width: 1920,
            height: 1080,
            fps: 60,
            bitrate: 16_000_000,
            startOptions: { kind: 'screen' },
          },
        ] as never,
        lastError: null,
        status: { status: 'running', sessionId: 'screen-session-1' },
      }),
    ).toMatchObject({
      engine: {
        activeSessions: [
          {
            kind: 'microphone',
            sessionId: 'mic-session-1',
          },
          {
            kind: 'screen',
            sessionId: 'screen-session-1',
            width: 1920,
            height: 1080,
            fps: 60,
            bitrate: 16_000_000,
          },
        ],
      },
    })
  })

  it('builds microphone connect command from session options', async () => {
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
      cmd: 'connect_microphone',
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

  it('keeps screen preflight as an explicit diagnostic command only', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./native-media-engine.ts', import.meta.url)),
      'utf8',
    )

    expect(source).toContain('buildScreenSharePreflightCommand')
    expect(source).toContain("cmd: 'probe_screen_share'")
    expect(source).not.toContain('await runNativeScreenSharePreflight(options, getWindow)')
    expect(source).toContain('function buildScreenSharePreflightCommand')
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
      /if \(event\.type === 'error'\) \{[\s\S]*?pendingStartResolvers\.delete\(eventSessionId\)[\s\S]*?return\s*\}/,
    )?.[0]

    expect(errorBranch).toBeDefined()
    expect(errorBranch).toContain('emitMediaEngineState')
    expect(errorBranch).toContain("status: 'error'")
  })

  it('keeps native session startup resolvers scoped by session id', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./native-media-engine.ts', import.meta.url)),
      'utf8',
    )

    expect(source).toContain(
      'const pendingStartResolvers = new Map<string, (event: SidecarEvent) => void>()',
    )
    expect(source).toContain('waitForSidecarReady(sessionId: string')
    expect(source).toContain('pendingStartResolvers.set(sessionId')
    expect(source).toContain('pendingStartResolvers.get(eventSessionId)?.(event)')
    expect(source).not.toContain('let pendingStartResolver')
  })

  it('prewarms one idle native helper for the first media session', () => {
    const engineSource = readFileSync(
      fileURLToPath(new URL('./native-media-engine.ts', import.meta.url)),
      'utf8',
    )
    const indexSource = readFileSync(
      fileURLToPath(new URL('./index.ts', import.meta.url)),
      'utf8',
    )

    expect(engineSource).toContain('export function prewarmNativeMediaEngineHelper')
    expect(engineSource).toContain("cmd: 'warm_microphone'")
    expect(engineSource).toContain('takePrewarmedMediaEngineHelper()')
    expect(engineSource).toContain('queueMicrophoneWarmupRestart()')
    expect(engineSource).toContain('microphoneWarmupEnabled = false')
    expect(engineSource).toContain(
      "kind === 'microphone'",
    )
    expect(indexSource).toContain('prewarmNativeMediaEngineHelper()')
    expect(indexSource).toContain('disposePrewarmedNativeMediaEngineHelper()')
  })

  it('disconnects native microphone publishing without stopping the persistent capture helper', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./native-media-engine.ts', import.meta.url)),
      'utf8',
    )
    const stopBody = source.match(
      /function stopMediaEngineSession[\s\S]*?function stopMediaEngineHelper/,
    )?.[0]

    expect(stopBody).toBeDefined()
    expect(stopBody).toContain("'disconnect_microphone'")
    expect(stopBody).toContain('keepMicrophoneHelperWarmed(session.helper)')
    expect(stopBody).not.toContain(
      "const shouldResumeMicrophoneWarmup = session.startOptions.kind === 'microphone'",
    )
    expect(stopBody).not.toContain(
      'prewarmNativeMediaEngineHelper({ allowDuringMicrophoneSession: true })',
    )
  })

  it('does not reuse the prewarmed microphone helper for screen sessions', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./native-media-engine.ts', import.meta.url)),
      'utf8',
    )
    const spawnBody = source.match(
      /function spawnMediaEngineHelper[\s\S]*?\r?\n\r?\n  const reader = readline\.createInterface/,
    )?.[0]

    expect(spawnBody).toBeDefined()
    expect(spawnBody).toContain("kind === 'microphone'")
    expect(spawnBody).toContain('takePrewarmedMediaEngineHelper()')
    expect(spawnBody).toContain(': spawnNativeMediaEngineProcess(kind)')
  })

  it('routes native microphone mute through a helper command without stopping the session', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./native-media-engine.ts', import.meta.url)),
      'utf8',
    )
    const nativeSource = readFileSync(
      fileURLToPath(
        new URL('../../native/native-voice-win/src/microphone_publisher.cpp', import.meta.url),
      ),
      'utf8',
    )

    expect(source).toContain('function setNativeMicrophoneMuted')
    expect(source).toContain("cmd: 'set_microphone_muted'")
    expect(source).toContain('IPC.mediaSetMicrophoneMuted')
    expect(nativeSource).toContain('commandMatches(line, "set_microphone_muted")')
    expect(nativeSource).toContain('audio_track->mute()')
    expect(nativeSource).toContain('audio_track->unmute()')
  })

  it('keeps the native microphone engine alive across warm, connect, and disconnect commands', () => {
    const mainSource = readFileSync(
      fileURLToPath(
        new URL('../../native/native-voice-win/src/main.cpp', import.meta.url),
      ),
      'utf8',
    )
    const nativeSource = readFileSync(
      fileURLToPath(
        new URL('../../native/native-voice-win/src/microphone_publisher.cpp', import.meta.url),
      ),
      'utf8',
    )

    expect(mainSource).toContain('runMicrophonePublisher(command)')
    expect(mainSource).not.toContain('stopMicrophoneWarmup();\n        runMicrophonePublisher(command)')
    expect(nativeSource).toContain('commandMatches(line, "connect_microphone")')
    expect(nativeSource).toContain('commandMatches(line, "disconnect_microphone")')
    expect(nativeSource).toContain('disconnectMicrophoneRoom')
    expect(nativeSource).not.toContain('g_running.store(false);\n      break;\n    }\n    if (commandMatches(line, "set_microphone_muted"))')
  })

  it('starts screen video capture before publishing the LiveKit screen track', () => {
    const source = readFileSync(
      fileURLToPath(
        new URL('../../native/native-voice-win/src/screen_publisher.cpp', import.meta.url),
      ),
      'utf8',
    )
    const captureIndex = source.indexOf('video_thread = std::thread')
    const publishIndex = source.indexOf('participant->publishTrack(video_track')

    expect(captureIndex).toBeGreaterThanOrEqual(0)
    expect(publishIndex).toBeGreaterThan(captureIndex)
    expect(source).toContain('video_source->captureFrame(frame, timestamp_us)')
    expect(source).toContain('\\"message\\":\\"publishing_video_track\\"')
    expect(source).toContain('LocalVideoTrack::createLocalVideoTrack("screen", video_source)')
    expect(source).toContain('video_publish_options.source = livekit::TrackSource::SOURCE_SCREENSHARE')
    expect(source).toContain('video_publish_options.simulcast = false')
    expect(source).toContain('chooseScreenShareBitratePreset')
  })

  it('unpublishes native screen tracks by stored publication SID instead of raw track SID', () => {
    const source = readFileSync(
      fileURLToPath(
        new URL('../../native/native-voice-win/src/screen_publisher.cpp', import.meta.url),
      ),
      'utf8',
    )

    expect(source).toContain('#include "livekit/local_track_publication.h"')
    expect(source).toContain('video_publication_sid')
    expect(source).toContain('audio_publication_sid')
    expect(source).toContain('video_track->publication()')
    expect(source).toContain('audio_track->publication()')
    expect(source).toContain('participant->unpublishTrack(track_sid)')
    expect(source).not.toContain('participant->unpublishTrack(track->sid())')
  })

  it('waits for native screen stop acknowledgement before resolving stop IPC', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./native-media-engine.ts', import.meta.url)),
      'utf8',
    )

    expect(source).toContain('const pendingStopResolvers')
    expect(source).toContain('waitForMediaEngineSessionStopped(sessionId)')
    expect(source).toContain('resolvePendingStop(event.session_id)')
    expect(source).toContain('await stopPromise')
  })

  it('requests borderless Windows Graphics Capture for window sessions when allowed', () => {
    const source = readFileSync(
      fileURLToPath(
        new URL('../../native/native-voice-win/src/screen_video_capture.cpp', import.meta.url),
      ),
      'utf8',
    )

    expect(source).toContain('GraphicsCaptureAccessKind::Borderless')
    expect(source).toContain('AppCapabilityAccessStatus::Allowed')
    expect(source).toContain('session.IsBorderRequired(false)')
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
