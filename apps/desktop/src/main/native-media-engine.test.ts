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

  it('does not route microphone audio through the main-process relay', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./native-media-engine.ts', import.meta.url)),
      'utf8',
    )
    const relayBody = source.match(
      /function forwardStreamAudioPayload[\s\S]*?\r?\n}\r?\n\r?\nfunction processAudioStreamBuffer/,
    )?.[0]

    expect(relayBody).toBeDefined()
    expect(relayBody).toContain("if (session.startOptions.kind === 'microphone') return")
    expect(relayBody).not.toContain('writePcmAudioRing')
  })
})
