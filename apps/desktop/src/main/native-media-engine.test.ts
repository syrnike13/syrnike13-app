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
          noiseSuppression: true,
          echoCancellation: true,
          inputVolume: 1.25,
          voiceGateAutoThreshold: true,
          audioBitrate: 48_000,
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
      noiseSuppression: true,
      echoCancellation: true,
      inputVolume: 1.25,
      voiceGateAutoThreshold: true,
      audioBitrate: 48_000,
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
          audioBitrate: 48_000,
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
      audioBitrate: 48_000,
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
          audioBitrate: 48_000,
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
      audioBitrate: 48_000,
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

  it('builds native microphone reconnect command from current runtime state', async () => {
    const { buildNativeMediaReconnectStartCommand } = await import(
      './native-media-engine'
    )

    expect(
      buildNativeMediaReconnectStartCommand(
        {
          startOptions: {
            kind: 'microphone',
            deviceId: 'default',
            sampleRate: 48_000,
            channels: 1,
            noiseSuppression: true,
            echoCancellation: true,
            inputVolume: 1,
            voiceGateEnabled: true,
            voiceGateThresholdDb: -42,
            muted: false,
            livekit: {
              url: 'wss://livekit.example',
              token: 'native-livekit-token',
              participantIdentity: 'user-1:desktop-native',
            },
          },
          effectiveMicrophoneConfig: {
            inputVolume: 0.35,
            noiseSuppression: false,
            voiceGateThresholdDb: -55,
          },
          effectiveMuted: true,
        },
        'mic-session-1',
        () => null,
      ),
    ).toMatchObject({
      cmd: 'connect_microphone',
      sessionId: 'mic-session-1',
      sessionKind: 'microphone',
      deviceId: 'default',
      inputVolume: 0.35,
      noiseSuppression: false,
      echoCancellation: true,
      voiceGateEnabled: true,
      voiceGateThresholdDb: -55,
      muted: true,
    })
  })

  it('handles replacement helper exits during reconnect but ignores stale helpers', async () => {
    const { shouldHandleNativeMediaHelperExit } = await import(
      './native-media-engine'
    )
    const oldHelper = {} as never
    const replacementHelper = {} as never

    expect(
      shouldHandleNativeMediaHelperExit(
        {
          helper: oldHelper,
          reconnecting: true,
          reconnectHelper: replacementHelper,
        },
        oldHelper,
      ),
    ).toBe(false)
    expect(
      shouldHandleNativeMediaHelperExit(
        {
          helper: oldHelper,
          reconnecting: true,
          reconnectHelper: replacementHelper,
        },
        replacementHelper,
      ),
    ).toBe(true)
    expect(
      shouldHandleNativeMediaHelperExit(
        {
          helper: replacementHelper,
          reconnecting: false,
        },
        oldHelper,
      ),
    ).toBe(false)
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
      'const pendingStartResolvers = createPendingStartResolverRegistry()',
    )
    expect(source).toContain('waitForSidecarReady(sessionId: string')
    expect(source).toContain('pendingStartResolvers.set(sessionId')
    expect(source).toContain('pendingStartResolvers.get(eventSessionId)?.(event)')
    expect(source).not.toContain('let pendingStartResolver')
  })

  it('fans out sidecar ready events to every waiter for the same session id', async () => {
    const { createPendingStartResolverRegistry } = await import(
      './native-media-engine'
    )
    const registry = createPendingStartResolverRegistry()
    const first = vi.fn()
    const second = vi.fn()
    const readyEvent = { type: 'ready', port: 0 }

    registry.set('session-1', first)
    registry.set('session-1', second)
    registry.get('session-1')?.(readyEvent as never)
    registry.delete('session-1')

    expect(first).toHaveBeenCalledWith(readyEvent)
    expect(second).toHaveBeenCalledWith(readyEvent)
    expect(registry.count('session-1')).toBe(0)
  })

  it('keeps native startup waiting while the sidecar reports lifecycle progress', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./native-media-engine.ts', import.meta.url)),
      'utf8',
    )
    const waitBody = source.match(
      /async function waitForSidecarReady[\s\S]*?\r?\n}\r?\n\r?\nasync function prepareNativeScreenSession/,
    )?.[0]
    const lifecycleBranch = source.match(
      /if \(event\.type === 'session_lifecycle'\) \{[\s\S]*?return\r?\n    \}/,
    )?.[0]

    expect(waitBody).toBeDefined()
    expect(waitBody).toContain('resetTimer()')
    expect(waitBody).toContain("event.type === 'session_lifecycle'")
    expect(waitBody).toContain("event.status === 'stopped'")
    expect(lifecycleBranch).toBeDefined()
    expect(lifecycleBranch).toContain('pendingStartResolvers.get(event.session_id)?.(event)')
  })

  it('explains native startup timeout with the last lifecycle stage and stderr line', async () => {
    const { buildNativeMediaStartupTimeoutMessage } = await import(
      './native-media-engine'
    )

    expect(
      buildNativeMediaStartupTimeoutMessage({
        sessionId: 'session-1',
        lastLifecycleMessage: 'livekit_connecting',
        stderrLines: [
          '[2026-06-14T12:48:23Z WARN livekit_api::signal_client] signal connection failed on v0 path: Timeout("signal connection timed out")',
          '[2026-06-14T12:48:26Z WARN livekit::rtc_engine] failed to connect: Signal(Timeout("validate request timed out")), retrying... (1/3)',
        ],
      }),
    ).toBe(
      'Native media engine timed out while livekit_connecting: failed to connect: Signal(Timeout("validate request timed out")), retrying... (1/3)',
    )
  })

  it('redacts token-like startup diagnostics before showing timeout details', async () => {
    const { buildNativeMediaStartupTimeoutMessage } = await import(
      './native-media-engine'
    )

    expect(
      buildNativeMediaStartupTimeoutMessage({
        sessionId: 'session-1',
        lastLifecycleMessage: 'livekit_connecting',
        stderrLines: [
          'request failed token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature',
        ],
      }),
    ).toBe(
      'Native media engine timed out while livekit_connecting: request failed token=[redacted]',
    )
  })

  it('rejects native startup waiters when the helper exits before ready', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./native-media-engine.ts', import.meta.url)),
      'utf8',
    )
    const exitBody = source.match(
      /function handleHelperExit[\s\S]*?\r?\n}\r?\n\r?\nfunction stopMediaEngineSession/,
    )?.[0]

    expect(exitBody).toBeDefined()
    expect(exitBody).toContain('pendingStartResolvers.count(sessionId) > 0')
    expect(exitBody).toContain('buildNativeMediaStartupFailureMessage')
    expect(exitBody).not.toContain('if (session.reconnecting) {')
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

  it('disposes the previous warmed microphone helper before replacing it', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./native-media-engine.ts', import.meta.url)),
      'utf8',
    )
    const disposeBody = source.match(
      /function disposePrewarmedMicrophoneHelper[\s\S]*?function keepMicrophoneHelperWarmed/,
    )?.[0]
    const keepBody = source.match(
      /function keepMicrophoneHelperWarmed[\s\S]*?function selectPrimaryActiveSession/,
    )?.[0]

    expect(disposeBody).toBeDefined()
    expect(disposeBody).toContain('prewarmedMediaEngineReader?.close()')
    expect(disposeBody).toContain("writeHelperCommand(helper, { cmd: 'stop' })")
    expect(disposeBody).toContain('helper.kill()')
    expect(keepBody).toBeDefined()
    expect(keepBody).toContain('const previousHelper = prewarmedMediaEngineHelper')
    expect(keepBody).toContain('previousHelper !== helper')
    expect(keepBody).toContain('disposePrewarmedMicrophoneHelper(previousHelper)')
  })

  it('stops an existing native microphone sidecar before starting another one', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./native-media-engine.ts', import.meta.url)),
      'utf8',
    )
    const startBody = source.match(
      /async function startNativeMediaSession[\s\S]*?activeSessions\.set\(sessionId, session\)/,
    )?.[0]

    expect(startBody).toBeDefined()
    expect(source).toContain('function stopActiveMicrophoneSessions()')
    expect(startBody).toContain('stopActiveMicrophoneSessions()')
  })

  it('stops existing native screen sidecars before starting another one', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./native-media-engine.ts', import.meta.url)),
      'utf8',
    )
    const stopScreenBody = source.match(
      /function stopActiveScreenSessions[\s\S]*?function cancelPendingMediaStarts/,
    )?.[0]
    const startHandler = source.match(
      /IPC\.mediaStartSession[\s\S]*?const start = startSessionQueues\[options\.kind\]\.then/,
    )?.[0]

    expect(stopScreenBody).toBeDefined()
    expect(stopScreenBody).toContain("session.startOptions.kind === 'screen'")
    expect(stopScreenBody).toContain('stopMediaEngineSession(session.sessionId, true)')
    expect(startHandler).toBeDefined()
    expect(startHandler).toContain('cancelPendingMediaStarts(options.kind)')
    expect(startHandler).toContain('stopActiveScreenSessions()')
  })

  it('only force-stops native microphone sessions that are still starting', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./native-media-engine.ts', import.meta.url)),
      'utf8',
    )
    const stopActiveBody = source.match(
      /function stopActiveMicrophoneSessions[\s\S]*?function stopActiveScreenSessions/,
    )?.[0]

    expect(stopActiveBody).toBeDefined()
    expect(stopActiveBody).toContain(
      'const force = pendingStartResolvers.count(session.sessionId) > 0',
    )
    expect(stopActiveBody).toContain('stopMediaEngineSession(session.sessionId, force)')
    expect(stopActiveBody).not.toContain('stopMediaEngineSession(session.sessionId, true)')
  })

  it('cancels pending native microphone starts before queueing a newer one', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./native-media-engine.ts', import.meta.url)),
      'utf8',
    )
    const stopBody = source.match(
      /function stopMediaEngineSession[\s\S]*?function stopActiveMicrophoneSessions/,
    )?.[0]
    const startHandler = source.match(
      /IPC\.mediaStartSession[\s\S]*?const start = startSessionQueues\[options\.kind\]\.then/,
    )?.[0]

    expect(stopBody).toBeDefined()
    expect(stopBody).toContain('const pendingStart = pendingStartResolvers.get(sessionId)')
    expect(stopBody).toContain("message: 'Native media engine start cancelled'")
    expect(source).toContain('const startSessionQueues')
    expect(source).not.toContain('let startSessionQueue: Promise<unknown>')
    expect(startHandler).toBeDefined()
    expect(startHandler).toContain("if (options.kind === 'microphone')")
    expect(startHandler).toContain('stopActiveMicrophoneSessions()')
  })

  it('drops stale queued native media starts before spawning sidecars', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./native-media-engine.ts', import.meta.url)),
      'utf8',
    )
    const startHandler = source.match(
      /IPC\.mediaStartSession[\s\S]*?startSessionQueues\[options\.kind\] = start\.catch/,
    )?.[0]
    const cancelBody = source.match(
      /function cancelPendingMediaStarts[\s\S]*?function assertMediaStartRequestCurrent/,
    )?.[0]

    expect(source).toContain('let latestStartRequestIds')
    expect(source).toContain('const startSessionQueues')
    expect(source).toContain('function assertMediaStartRequestCurrent')
    expect(startHandler).toBeDefined()
    expect(startHandler).toContain('latestStartRequestIds[options.kind] = options.requestId')
    expect(startHandler).toContain('assertMediaStartRequestCurrent(options)')
    expect(cancelBody).toBeDefined()
    expect(cancelBody).toContain('stopMediaEngineSession(session.sessionId, true)')
    expect(source).toContain('IPC.mediaCancelPendingStarts')
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

  it('reattaches the helper reader when adopting a prepared screen helper', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./native-media-engine.ts', import.meta.url)),
      'utf8',
    )
    const spawnBody = source.match(
      /function spawnMediaEngineHelper[\s\S]*?\r?\n\r?\n  const reader = readline\.createInterface/,
    )?.[0]

    expect(spawnBody).toBeDefined()
    expect(spawnBody).toContain('if (!existingHelper) return helper')
    expect(spawnBody).toContain('closeMediaEngineHelperReader(helper)')
  })

  it('consumes the prepared screen helper before starting capture', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./native-media-engine.ts', import.meta.url)),
      'utf8',
    )
    const takeBody = source.match(
      /async function takePreconnectedScreenHelper[\s\S]*?function mapSidecarAudioMetadata/,
    )?.[0]

    expect(takeBody).toBeDefined()
    expect(takeBody).toContain('preconnectedScreenSession = null')
    expect(source).toContain('await takePreconnectedScreenHelper(options.livekit)')
    expect(source).not.toContain('await getPreconnectedScreenHelper(options.livekit)')
  })

  it('stops abandoned prepared screen helpers instead of disconnecting and leaking them', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./native-media-engine.ts', import.meta.url)),
      'utf8',
    )
    const clearBody = source.match(
      /function clearPreconnectedScreenSession[\s\S]*?function spawnNativeMediaEngineProcess/,
    )?.[0]
    const disconnectHandler = source.match(
      /IPC\.mediaDisconnectPreparedScreenSession[\s\S]*?\r?\n  \)/,
    )?.[0]

    expect(clearBody).toBeDefined()
    expect(clearBody).toContain("cmd: 'stop'")
    expect(clearBody).not.toContain('disconnect_screen')
    expect(clearBody).toContain('helper.kill()')
    expect(disconnectHandler).toBeDefined()
    expect(disconnectHandler).toContain('clearPreconnectedScreenSession(false)')
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
    expect(nativeSource).toContain('connected.room->disconnect()')
    expect(nativeSource).not.toContain('g_running.store(false);\n      break;\n    }\n    if (commandMatches(line, "set_microphone_muted"))')
  })

  it('publishes native microphone audio with explicit Opus voice options', () => {
    const nativeSource = readFileSync(
      fileURLToPath(
        new URL('../../native/native-voice-win/src/microphone_publisher.cpp', import.meta.url),
      ),
      'utf8',
    )

    expect(nativeSource).toContain('LocalAudioTrack::createLocalAudioTrack("microphone", audio_source)')
    expect(nativeSource).toContain('livekit::TrackPublishOptions publish_options')
    expect(nativeSource).toContain('audio_encoding.max_bitrate = command.audio_bitrate')
    expect(nativeSource).not.toContain('audio_encoding.max_bitrate = 64000')
    expect(nativeSource).toContain('publish_options.dtx = true')
    expect(nativeSource).toContain('publish_options.source = livekit::TrackSource::SOURCE_MICROPHONE')
    expect(nativeSource).toContain('participant->publishTrack(audio_track, publish_options)')
    expect(nativeSource).not.toContain('participant->publishAudioTrack(')
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

  it('publishes native screen audio as stereo music without dtx', () => {
    const source = readFileSync(
      fileURLToPath(
        new URL('../../native/native-voice-win/src/screen_publisher.cpp', import.meta.url),
      ),
      'utf8',
    )

    expect(source).toContain('std::make_shared<livekit::AudioSource>(48000, 2)')
    expect(source).toContain('LocalAudioTrack::createLocalAudioTrack("screen-audio", active.audio_source)')
    expect(source).toContain('audio_encoding.max_bitrate = command.audio_bitrate')
    expect(source).not.toContain('audio_encoding.max_bitrate = 128000')
    expect(source).toContain('audio_publish_options.dtx = false')
    expect(source).toContain('audio_publish_options.red = false')
    expect(source).toContain('audio_publish_options.source = livekit::TrackSource::SOURCE_SCREENSHARE_AUDIO')
    expect(source).toContain('participant->publishTrack(active.audio_track, audio_publish_options)')
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

  it('keeps the native screen helper reader open until graceful stop acknowledgement', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./native-media-engine.ts', import.meta.url)),
      'utf8',
    )
    const stopBody = source.match(
      /function stopMediaEngineSession[\s\S]*?function stopActiveMicrophoneSessions/,
    )?.[0]
    const stoppedBranch = source.match(
      /if \(event\.status === 'stopped'\) \{[\s\S]*?return\r?\n      \}/,
    )?.[0]

    expect(stopBody).toBeDefined()
    expect(stopBody).toContain('const waitsForScreenStop')
    expect(stopBody).toContain("session.startOptions.kind === 'screen'")
    expect(stopBody).toContain('session.stopping = true')
    expect(stopBody).toContain('if (!waitsForScreenStop)')
    expect(stoppedBranch).toBeDefined()
    expect(stoppedBranch).toContain('resolvePendingStop(event.session_id)')
    expect(stoppedBranch).toContain('activeSessions.delete(event.session_id)')
    expect(stoppedBranch).toContain('closeIdleMediaEngineHelperReader(helper)')
  })

  it('tracks stopping native screen sessions for cleanup without exposing them as running', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./native-media-engine.ts', import.meta.url)),
      'utf8',
    )
    const selectPrimaryBody = source.match(
      /function selectPrimaryActiveSession[\s\S]*?function runningStatusForSession/,
    )?.[0]
    const stopBody = source.match(
      /function stopMediaEngineSession[\s\S]*?function stopActiveMicrophoneSessions/,
    )?.[0]

    expect(source).toContain('stopping: boolean')
    expect(selectPrimaryBody).toBeDefined()
    expect(selectPrimaryBody).toContain(
      'Array.from(activeSessions.values()).filter',
    )
    expect(selectPrimaryBody).toContain('!active.stopping')
    expect(stopBody).toBeDefined()
    expect(stopBody).toContain('if (session.stopping)')
    expect(stopBody).toContain('if (!force) return true')
    expect(stopBody).toContain('resolvePendingStop(sessionId)')
    expect(stopBody).not.toContain('Native media engine force-stopped while stopping')
    expect(stopBody).toContain('session.stopping = true')
    expect(stopBody).toContain('activeSessions.delete(sessionId)')
  })

  it('force-cleans a native screen helper when graceful stop acknowledgement times out', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./native-media-engine.ts', import.meta.url)),
      'utf8',
    )
    const waitBody = source.match(
      /async function waitForMediaEngineSessionStopped[\s\S]*?async function prepareNativeScreenSession/,
    )?.[0]

    expect(waitBody).toBeDefined()
    expect(waitBody).toContain('const existing = pendingStopResolvers.get(sessionId)')
    expect(waitBody).toContain('if (existing) return existing.wait')
    expect(waitBody).toContain("event: 'native-stop-timeout-force-kill'")
    expect(waitBody).toContain('stopMediaEngineSession(sessionId, true)')
  })

  it('stops orphan native helpers that keep emitting diagnostics after their session is gone', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./native-media-engine.ts', import.meta.url)),
      'utf8',
    )
    const reconcileBody = source.match(
      /function reconcileUnownedMediaEngineHelperEvent[\s\S]*?function clearPreconnectedScreenSession/,
    )?.[0]

    expect(source).toContain('const orphanMediaEngineHelpers')
    expect(reconcileBody).toBeDefined()
    expect(reconcileBody).toContain('helperHasActiveSession(helper)')
    expect(reconcileBody).toContain('preconnectedScreenSession?.helper === helper')
    expect(reconcileBody).toContain('prewarmedMediaEngineHelper === helper')
    expect(reconcileBody).toContain('closeMediaEngineHelperReader(helper)')
    expect(reconcileBody).toContain("event: 'native-orphan-helper-stopped'")
    expect(reconcileBody).toContain("writeHelperCommand(helper, { cmd: 'stop' })")
    expect(reconcileBody).toContain('helper.kill()')
    expect(source).toContain('!session &&')
    expect(source).toContain('reconcileUnownedMediaEngineHelperEvent(')
    expect(source).toContain("'microphone-diagnostics-without-session'")
  })

  it('stops native screen capture when the selected window closes', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./native-media-engine.ts', import.meta.url)),
      'utf8',
    )
    const endedBranch = source.match(
      /if \(event\.type === 'screen_capture_ended'\) \{[\s\S]*?return\r?\n    \}/,
    )?.[0]

    expect(endedBranch).toBeDefined()
    expect(endedBranch).toContain('IPC.mediaStreamEnded')
    expect(endedBranch).toContain("cmd: 'stop_screen_capture'")
    expect(endedBranch).toContain('stopMediaEngineSession(event.session_id, true)')
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

  it('links WinRT runtime libraries required by Windows Graphics Capture', () => {
    const source = readFileSync(
      fileURLToPath(
        new URL('../../native/native-voice-win/CMakeLists.txt', import.meta.url),
      ),
      'utf8',
    )

    expect(source).toContain('runtimeobject')
  })

  it('runs native C++ tests in the Windows PR workflow after building the helper', () => {
    const workflow = readFileSync(
      fileURLToPath(
        new URL('../../../../.github/workflows/native-media-windows.yml', import.meta.url),
      ),
      'utf8',
    )

    const buildIndex = workflow.indexOf('Build native voice helper')
    const testIndex = workflow.indexOf('ctest --test-dir apps/desktop/native/native-voice-win/build')

    expect(buildIndex).toBeGreaterThanOrEqual(0)
    expect(testIndex).toBeGreaterThan(buildIndex)
    expect(workflow).toContain('--output-on-failure')
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
