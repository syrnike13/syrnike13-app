import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getAppPath: () => 'C:\\syrnike',
    getVersion: () => '0.6.11',
    isPackaged: false,
  },
  utilityProcess: { fork: vi.fn() },
}))

vi.stubGlobal('__DESKTOP_COMMIT_SHA__', 'a'.repeat(40))

import { MEDIA_LIFECYCLE_PROTOCOL_VERSION } from './contract'
import { ElectronMediaUtilityAdapter } from './media-utility-adapter'

class FakeUtilityProcess extends EventEmitter {
  pid = 42
  postMessage = vi.fn()
  kill = vi.fn()
  stderr = new Readable({ read() {} })
}

describe('ElectronMediaUtilityAdapter', () => {
  it('starts the production host with the current media protocol version', () => {
    const child = new FakeUtilityProcess()
    const fork = vi.fn(() => child)
    const adapter = new ElectronMediaUtilityAdapter({
      utilityEntryPath: 'C:\\syrnike\\media-host.cjs',
      nativeModulePath: 'C:\\syrnike\\windows_media.node',
      fork,
    })

    adapter.start({ onMessage: vi.fn(), onExit: vi.fn() })

    expect(fork.mock.calls[0]?.[2]?.env).toMatchObject({
      SYRNIKE_MEDIA_PROTOCOL_VERSION: String(MEDIA_LIFECYCLE_PROTOCOL_VERSION),
      SYRNIKE_MEDIA_MODULE_PATH: 'C:\\syrnike\\windows_media.node',
    })
  })
})
