import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

const nativeBrokerMocks = vi.hoisted(() => ({
  load: vi.fn(),
  verify: vi.fn(),
}))

vi.mock('node:module', () => ({ createRequire: () => nativeBrokerMocks.load }))
vi.mock('./media-artifacts', () => ({
  verifyMediaArtifactDistribution: nativeBrokerMocks.verify,
}))

vi.mock('electron', () => ({
  app: {
    getAppPath: () => 'C:\\syrnike',
    getVersion: () => '0.6.11',
    isPackaged: false,
  },
  utilityProcess: { fork: vi.fn() },
}))

vi.stubGlobal('__DESKTOP_COMMIT_SHA__', 'a'.repeat(40))

import {
  MEDIA_LIFECYCLE_PROTOCOL_VERSION,
  MEDIA_UTILITY_BOOTSTRAP_MESSAGE,
} from './contract'
import { ElectronMediaUtilityAdapter } from './media-utility-adapter'

class FakeUtilityProcess extends EventEmitter {
  pid = 42
  postMessage = vi.fn()
  kill = vi.fn()
  stderr = new Readable({ read() {} })
}

describe('ElectronMediaUtilityAdapter', () => {
  it('retains the verified native exit deadline after the utility exits', async () => {
    vi.resetModules()
    const { ElectronMediaUtilityAdapter, armMediaProcessExitDeadline } =
      await import('./media-utility-adapter')
    nativeBrokerMocks.load.mockClear()
    nativeBrokerMocks.verify.mockClear()
    armMediaProcessExitDeadline(4_000)
    expect(nativeBrokerMocks.load).not.toHaveBeenCalled()

    const child = new FakeUtilityProcess()
    const guard = { terminate: vi.fn(), hasExited: () => true, close: vi.fn() }
    const armProcessExitDeadline = vi.fn()
    nativeBrokerMocks.load.mockReturnValue({
      openUtilityProcess: () => guard,
      armProcessExitDeadline,
    })
    const fork = vi.fn(() => {
      expect(nativeBrokerMocks.verify).toHaveBeenCalledTimes(1)
      return child
    })
    const adapter = new ElectronMediaUtilityAdapter({
      utilityEntryPath: 'C:\\syrnike\\media-host.cjs',
      nativeModulePath: 'C:\\syrnike\\windows_media.node',
      fork,
    })
    adapter.start({ onMessage: vi.fn(), onExit: vi.fn() })
    child.emit('spawn')
    child.emit('exit', 0)
    armMediaProcessExitDeadline(4_000)
    expect(armProcessExitDeadline).toHaveBeenCalledWith(4_000)
    expect(nativeBrokerMocks.load).toHaveBeenCalledTimes(1)
    expect(nativeBrokerMocks.verify).toHaveBeenCalledTimes(1)
  })

  it('rejects a broker without a native exit deadline before spawning media', async () => {
    vi.resetModules()
    const { ElectronMediaUtilityAdapter } = await import('./media-utility-adapter')
    nativeBrokerMocks.load.mockReturnValue({ openUtilityProcess: vi.fn() })
    const fork = vi.fn(() => new FakeUtilityProcess())
    const adapter = new ElectronMediaUtilityAdapter({
      utilityEntryPath: 'C:\\syrnike\\media-host.cjs',
      nativeModulePath: 'C:\\syrnike\\windows_media.node',
      fork,
    })
    expect(() => adapter.start({ onMessage: vi.fn(), onExit: vi.fn() }))
      .toThrow('Invalid utility process broker')
    expect(fork).not.toHaveBeenCalled()
  })

  it('starts the production host with the current media protocol version', () => {
    vi.useFakeTimers()
    const child = new FakeUtilityProcess()
    const fork = vi.fn(() => child)
    const adapter = new ElectronMediaUtilityAdapter({
      utilityEntryPath: 'C:\\syrnike\\media-host.cjs',
      nativeModulePath: 'C:\\syrnike\\windows_media.node',
      fork,
      openProcess: () => ({ terminate: vi.fn(), hasExited: () => false, close: vi.fn() }),
    })

    adapter.start({ onMessage: vi.fn(), onExit: vi.fn() })

    expect(fork.mock.calls[0]?.[2]?.env).toMatchObject({
      SYRNIKE_MEDIA_PROTOCOL_VERSION: String(MEDIA_LIFECYCLE_PROTOCOL_VERSION),
      SYRNIKE_MEDIA_MODULE_PATH: 'C:\\syrnike\\windows_media.node',
    })
    child.emit('spawn')
    expect(child.postMessage).toHaveBeenCalledWith(
      MEDIA_UTILITY_BOOTSTRAP_MESSAGE,
    )
    vi.advanceTimersByTime(50)
    expect(child.postMessage).toHaveBeenCalledTimes(3)
    child.emit('message', { type: 'ready' })
    vi.advanceTimersByTime(50)
    expect(child.postMessage).toHaveBeenCalledTimes(3)
    vi.useRealTimers()
  })

  it('forces the retained process and waits for its kernel exit before resolving kill', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeUtilityProcess()
      let exited = false
      const guard = { terminate: vi.fn(), hasExited: () => exited, close: vi.fn() }
      const adapter = new ElectronMediaUtilityAdapter({
        utilityEntryPath: 'C:\\syrnike\\media-host.cjs',
        nativeModulePath: 'C:\\syrnike\\windows_media.node',
        fork: () => child, openProcess: () => guard,
      })
      adapter.start({ onMessage: vi.fn(), onExit: vi.fn() })
      child.emit('spawn')
      let finished = false
      const killed = adapter.kill().then(() => { finished = true })
      await vi.advanceTimersByTimeAsync(100)
      expect(guard.terminate).toHaveBeenCalledTimes(1)
      expect(child.kill).not.toHaveBeenCalled()
      expect(finished).toBe(false)
      exited = true
      await vi.advanceTimersByTimeAsync(10)
      await killed
      expect(guard.close).toHaveBeenCalledTimes(1)
      expect(adapter.pid).toBeUndefined()
    } finally { vi.useRealTimers() }
  })
})
