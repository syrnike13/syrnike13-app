import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getAppPath: () => 'C:\\syrnike',
    getVersion: () => '0.5.1',
    isPackaged: false,
  },
  utilityProcess: { fork: vi.fn() },
}))

vi.stubGlobal('__DESKTOP_COMMIT_SHA__', 'a'.repeat(40))

import { ElectronUtilityAdapter } from './utility-adapter'

class FakeUtilityProcess extends EventEmitter {
  pid = 42
  postMessage = vi.fn()
  kill = vi.fn()
}

describe('ElectronUtilityAdapter', () => {
  it('ignores native stdio and terminates an errored host exactly once', () => {
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
    expect(fork.mock.calls[0]?.[2]).toMatchObject({ stdio: 'ignore' })
    expect(fork.mock.calls[0]?.[2]?.env).toMatchObject({
      SYRNIKE_NATIVE_APP_VERSION: '0.5.1',
      SYRNIKE_NATIVE_CONTRACT_VERSION: '2',
      SYRNIKE_NATIVE_LIVEKIT_VERSION: '1.3.0',
      SYRNIKE_NATIVE_COMMIT_SHA: 'a'.repeat(40),
      SYRNIKE_NATIVE_RELEASE_CHANNEL: 'stable',
      SYRNIKE_NATIVE_RUNTIME_KIND: 'media',
    })
    expect(fork.mock.calls[0]?.[2]?.env).not.toHaveProperty('PATH')

    child.emit('error', new Error('host transport failed'))
    child.emit('exit', 1)

    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(onExit).toHaveBeenCalledWith({
      code: null,
      error: expect.objectContaining({ message: 'Error: host transport failed' }),
    })
  })
})
