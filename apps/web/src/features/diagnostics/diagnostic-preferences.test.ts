import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  readBrowserDiagnosticReportsEnabled,
  resetBrowserDiagnosticPreferenceForTests,
  writeBrowserDiagnosticReportsEnabled,
} from './diagnostic-preferences'

const CURRENT_KEY = 'syrnike13:diagnostic-reports:v2'
const LEGACY_KEY = 'syrnike13:diagnostic-reports:v1'

describe('browser diagnostic preferences', () => {
  const values = new Map<string, string>()

  beforeEach(() => {
    values.clear()
    resetBrowserDiagnosticPreferenceForTests()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
  })

  it('enables reports once for existing browsers', () => {
    values.set(LEGACY_KEY, 'enabled')

    expect(readBrowserDiagnosticReportsEnabled()).toBe(true)
    expect(values.get(CURRENT_KEY)).toBe('enabled')
    expect(values.has(LEGACY_KEY)).toBe(false)
  })

  it('preserves an explicit opt-out after the migration', () => {
    expect(readBrowserDiagnosticReportsEnabled()).toBe(true)
    writeBrowserDiagnosticReportsEnabled(false)

    expect(readBrowserDiagnosticReportsEnabled()).toBe(false)
    expect(values.get(CURRENT_KEY)).toBe('disabled')
  })

  it('fails closed and preserves an in-memory opt-out when storage rejects writes', () => {
    values.set(CURRENT_KEY, 'enabled')
    expect(readBrowserDiagnosticReportsEnabled()).toBe(true)

    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: () => {
        throw new DOMException('Storage is blocked', 'SecurityError')
      },
      removeItem: () => undefined,
    })

    expect(writeBrowserDiagnosticReportsEnabled(false)).toBe(false)
    expect(readBrowserDiagnosticReportsEnabled()).toBe(false)
  })

  it('disables automatic reports when storage cannot be read', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new DOMException('Storage is blocked', 'SecurityError')
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    })

    expect(readBrowserDiagnosticReportsEnabled()).toBe(false)
  })
})
