import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMock = vi.hoisted(() => ({
  getPrimaryDisplay: vi.fn(),
}))

vi.mock('electron', () => ({
  screen: { getPrimaryDisplay: electronMock.getPrimaryDisplay },
}))

import {
  collectDesktopSystemInfo,
  describeWindowsRelease,
  formatDisplay,
} from './system-info'

describe('describeWindowsRelease', () => {
  it('maps known Windows build numbers to marketing names', () => {
    expect(describeWindowsRelease('10.0.26100')).toBe(
      'Windows 11 24H2 (build 26100)',
    )
    expect(describeWindowsRelease('10.0.19045')).toBe(
      'Windows 10 22H2 (build 19045)',
    )
  })

  it('keeps the raw version for unknown builds', () => {
    expect(describeWindowsRelease('10.0.99999')).toBe('Windows 10.0.99999')
    expect(describeWindowsRelease('11.0')).toBe('Windows 11.0')
  })
})

describe('formatDisplay', () => {
  it('reports physical pixels and refresh rate', () => {
    expect(
      formatDisplay({
        width: 1280,
        height: 720,
        scaleFactor: 2,
        displayFrequency: 165,
      }),
    ).toBe('2560x1440 @ 165 Hz')
  })

  it('omits the refresh rate when the OS does not report it', () => {
    expect(
      formatDisplay({ width: 1920, height: 1080, scaleFactor: 1 }),
    ).toBe('1920x1080')
  })

  it('ignores unusable displays', () => {
    expect(formatDisplay({ width: 0, height: 0, scaleFactor: 1 })).toBeNull()
    expect(
      formatDisplay({
        width: 1920,
        height: 1080,
        scaleFactor: 1,
        displayFrequency: 0,
      }),
    ).toBe('1920x1080')
  })
})

describe('collectDesktopSystemInfo', () => {
  beforeEach(() => {
    electronMock.getPrimaryDisplay.mockReturnValue({
      size: { width: 1280, height: 720 },
      scaleFactor: 2,
      displayFrequency: 165,
    })
  })

  it('reads the machine without touching the network', () => {
    const info = collectDesktopSystemInfo()

    expect(info.os.length).toBeGreaterThan(0)
    expect(info.cpu_threads).toBeGreaterThan(0)
    expect(info.memory_bytes).toBeGreaterThan(0)
    expect(info.display).toBe('2560x1440 @ 165 Hz')
  })
})
