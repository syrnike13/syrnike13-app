// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const desktopRuntime = vi.hoisted(() => ({ getSyrnikeDesktop: vi.fn() }))

vi.mock('#/platform/runtime', () => ({
  getSyrnikeDesktop: desktopRuntime.getSyrnikeDesktop,
}))

import {
  cleanGpuName,
  collectFeedbackSystem,
  describeBrowserSystem,
  hasSystemDetails,
} from './system-info'

describe('cleanGpuName', () => {
  it('unwraps the ANGLE description down to the device name', () => {
    expect(
      cleanGpuName(
        'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      ),
    ).toBe('NVIDIA GeForce RTX 3070')
  })

  it('keeps a plain renderer string as-is', () => {
    expect(cleanGpuName('Apple M2 Pro')).toBe('Apple M2 Pro')
    expect(cleanGpuName('AMD Radeon RX 6800 XT (0x00000073)')).toBe(
      'AMD Radeon RX 6800 XT (0x00000073)',
    )
  })

  it('returns null for blank input', () => {
    expect(cleanGpuName('   ')).toBeNull()
  })
})

describe('describeBrowserSystem', () => {
  it('detects Windows 11 from the reported platform version', () => {
    expect(
      describeBrowserSystem({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        platform: 'Windows',
        platformVersion: '15.0.0',
      }),
    ).toBe('Windows 11')
  })

  it('keeps older Windows on 10', () => {
    expect(
      describeBrowserSystem({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        platform: 'Windows',
        platformVersion: '10.0.0',
      }),
    ).toBe('Windows 10')
  })

  it('names macOS with its version and falls back to the raw platform', () => {
    expect(
      describeBrowserSystem({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        platform: 'macOS',
        platformVersion: '15.3.1',
      }),
    ).toBe('macOS 15.3.1')

    expect(
      describeBrowserSystem({
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
        platform: null,
        platformVersion: null,
      }),
    ).toBe('Linux')
  })
})

describe('collectFeedbackSystem', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    })
    Object.defineProperty(window.screen, 'width', {
      configurable: true,
      value: 1920,
    })
    Object.defineProperty(window.screen, 'height', {
      configurable: true,
      value: 1080,
    })
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      value: 1,
    })
  })

  it('merges the desktop summary with browser data', async () => {
    desktopRuntime.getSyrnikeDesktop.mockReturnValue({
      system: {
        getInfo: async () => ({
          os: 'Windows 11 24H2 (build 26100)',
          cpu: 'AMD Ryzen 7 5800X3D',
          cpu_threads: 16,
          memory_bytes: 34_359_738_368,
          display: '2560x1440 @ 165 Hz',
        }),
      },
    })

    const system = await collectFeedbackSystem()

    expect(system.os).toBe('Windows 11 24H2 (build 26100)')
    expect(system.cpu).toBe('AMD Ryzen 7 5800X3D')
    expect(system.cpu_threads).toBe(16)
    expect(system.memory_bytes).toBe(34_359_738_368)
    expect(system.display).toBe('2560x1440 @ 165 Hz')
    expect(hasSystemDetails(system)).toBe(true)
  })

  it('falls back to browser values when the desktop bridge is missing', async () => {
    desktopRuntime.getSyrnikeDesktop.mockReturnValue(null)

    const system = await collectFeedbackSystem()

    expect(system.os).toBe('Windows 10')
    expect(system.cpu).toBeNull()
    expect(system.memory_bytes).toBeNull()
    expect(system.display).toBe('1920x1080')
  })

  it('survives a failing desktop bridge', async () => {
    desktopRuntime.getSyrnikeDesktop.mockReturnValue({
      system: {
        getInfo: async () => {
          throw new Error('ipc failed')
        },
      },
    })

    const system = await collectFeedbackSystem()

    expect(system.os).toBe('Windows 10')
    expect(system.display).toBe('1920x1080')
    expect(hasSystemDetails(system)).toBe(true)
  })
})

describe('hasSystemDetails', () => {
  it('rejects empty summaries', () => {
    expect(hasSystemDetails(null)).toBe(false)
    expect(hasSystemDetails({})).toBe(false)
    expect(hasSystemDetails({ gpu: 'NVIDIA GeForce RTX 3070' })).toBe(true)
  })
})
