import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtimeMocks = vi.hoisted(() => ({
  engines: [] as Array<{
    dispose: ReturnType<typeof vi.fn>
    prewarmMicrophone: ReturnType<typeof vi.fn>
  }>,
  transports: [] as Array<{
    configured: Array<{ url: string; token: string }>
    stop: ReturnType<typeof vi.fn>
  }>,
}))

vi.mock('electron', () => ({
  powerMonitor: {
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}))

vi.mock('../desktop-app-identity', () => ({
  DESKTOP_RELEASE_METADATA: { publicHost: 'example.invalid' },
}))

vi.mock('../hotkeys', () => ({
  subscribeHotkeyActivations: vi.fn(() => () => undefined),
}))

vi.mock('../native-media-engine', () => ({
  logNativeVoiceDiagnostic: vi.fn(),
  createNativeRtcEngineAdapter: vi.fn(() => {
    const engine = {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      updateDesiredMedia: vi.fn(),
      updateRemoteAudioSettings: vi.fn(),
      retryMedia: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
      prewarmMicrophone: vi.fn(async () => undefined),
      dispose: vi.fn(),
    }
    runtimeMocks.engines.push(engine)
    return engine
  }),
}))

vi.mock('./desktop-voice-gateway-transport', () => ({
  DesktopVoiceGatewayTransport: class {
    readonly configured: Array<{ url: string; token: string }> = []
    readonly stop = vi.fn()

    constructor() {
      runtimeMocks.transports.push(this)
    }

    configure(url: string, token: string) {
      this.configured.push({ url, token })
    }

    sendReliable() {}
    subscribeEvents() { return () => undefined }
    subscribeState() { return () => undefined }
  },
}))

import { DesktopVoiceService } from './desktop-voice-service'

describe('DesktopVoiceService session scope', () => {
  beforeEach(() => {
    runtimeMocks.engines.length = 0
    runtimeMocks.transports.length = 0
  })

  it('rotates runtime ownership across accounts but not for a token refresh', async () => {
    const service = new DesktopVoiceService()
    expect(runtimeMocks.engines).toHaveLength(1)

    service.configureSession({ _id: 'session-a', user_id: 'user-a', token: 'token-a' })
    await service.dispatch({ type: 'setUserMuted', muted: true })
    expect(runtimeMocks.engines).toHaveLength(2)
    expect(runtimeMocks.engines[0].dispose).toHaveBeenCalledTimes(1)
    expect(runtimeMocks.transports[1].configured.at(-1)?.token).toBe('token-a')

    service.configureSession({
      _id: 'session-a',
      user_id: 'user-a',
      token: 'token-a-refreshed',
    })
    await service.dispatch({ type: 'setUserMuted', muted: false })
    expect(runtimeMocks.engines).toHaveLength(2)
    expect(runtimeMocks.transports[1].configured.at(-1)?.token).toBe(
      'token-a-refreshed',
    )

    service.configureSession({ _id: 'session-b', user_id: 'user-b', token: 'token-b' })
    await service.dispatch({ type: 'setUserMuted', muted: true })
    expect(runtimeMocks.engines).toHaveLength(3)
    expect(runtimeMocks.engines[1].dispose).toHaveBeenCalledTimes(1)
    expect(runtimeMocks.transports[1].stop).toHaveBeenCalledTimes(1)
    expect(runtimeMocks.transports[2].configured.at(-1)?.token).toBe('token-b')

    await service.dispose()
  })
})
