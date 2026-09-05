import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

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

import { DESKTOP_RELEASE_CHANNEL } from '../desktop-app-identity'
import type { NativeRuntimeRequest } from './contract'
import { BoundedByteTail, ElectronUtilityAdapter } from './utility-adapter'

class FakeUtilityProcess extends EventEmitter {
  pid = 42
  postMessage = vi.fn()
  kill = vi.fn()
  stderr = new Readable({ read() {} })
}

describe('ElectronUtilityAdapter hook boundary', () => {
  it('starts only a hook host with an allowlisted environment', () => {
    const child = new FakeUtilityProcess()
    const fork = vi.fn(() => child)
    const adapter = new ElectronUtilityAdapter({
      runtime: 'hotkey',
      utilityEntryPath: 'C:\\syrnike\\hotkey-host.cjs',
      nativeModulePath: 'C:\\syrnike\\syrnike_hotkey.node',
      fork,
    })

    adapter.start({ onMessage: vi.fn(), onExit: vi.fn() })

    expect(fork.mock.calls[0]?.[2]).toMatchObject({
      serviceName: 'syrnike-hotkey-runtime',
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    expect(fork.mock.calls[0]?.[2]?.env).toMatchObject({
      SYRNIKE_NATIVE_APP_VERSION: '0.5.1',
      SYRNIKE_NATIVE_CONTRACT_VERSION: '10',
      SYRNIKE_NATIVE_COMMIT_SHA: 'a'.repeat(40),
      SYRNIKE_NATIVE_RELEASE_CHANNEL: DESKTOP_RELEASE_CHANNEL,
      SYRNIKE_NATIVE_RUNTIME_KIND: 'hotkey',
      SYRNIKE_NATIVE_MODULE_PATH: 'C:\\syrnike\\syrnike_hotkey.node',
    })
    expect(fork.mock.calls[0]?.[2]?.env).not.toHaveProperty('PATH')
    expect(fork.mock.calls[0]?.[2]?.env).not.toHaveProperty(
      'SYRNIKE_NATIVE_MEDIA_LOG_PATH',
    )
  })

  it('forwards typed requests and child messages unchanged', () => {
    const child = new FakeUtilityProcess()
    const onMessage = vi.fn()
    const adapter = new ElectronUtilityAdapter({
      runtime: 'overlay',
      utilityEntryPath: 'C:\\syrnike\\overlay-host.cjs',
      nativeModulePath: 'C:\\syrnike\\syrnike_overlay.node',
      fork: () => child,
    })
    adapter.start({ onMessage, onExit: vi.fn() })
    const request: NativeRuntimeRequest = {
      type: 'request',
      requestId: 'overlay-1',
      lane: 'overlay',
      hostEpoch: 1,
      command: { type: 'startOverlay' },
    }

    adapter.postMessage(request)
    child.emit('message', { type: 'reply', requestId: 'overlay-1', ok: true })

    expect(child.postMessage).toHaveBeenCalledWith(request)
    expect(onMessage).toHaveBeenCalledWith({
      type: 'reply',
      requestId: 'overlay-1',
      ok: true,
    })
  })

  it('drains bounded stderr and reports one terminal exit', async () => {
    const child = new FakeUtilityProcess()
    const onExit = vi.fn()
    const adapter = new ElectronUtilityAdapter({
      runtime: 'hotkey',
      utilityEntryPath: 'C:\\syrnike\\hotkey-host.cjs',
      nativeModulePath: 'C:\\syrnike\\syrnike_hotkey.node',
      fork: () => child,
    })
    adapter.start({ onMessage: vi.fn(), onExit })

    child.stderr.emit('data', Buffer.from('fatal hook failure'))
    child.emit('error', new Error('host transport failed'))
    child.emit('exit', 1)
    child.stderr.push(null)

    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1))
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(onExit).toHaveBeenCalledWith(
      expect.objectContaining({
        code: null,
        terminationSource: 'error',
        stderrBytesSeen: 18,
        stderrBytesCaptured: 18,
        stderrTruncated: false,
      }),
    )
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
