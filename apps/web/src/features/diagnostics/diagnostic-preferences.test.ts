import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  readBrowserDiagnosticReportsEnabled,
  writeBrowserDiagnosticReportsEnabled,
} from './diagnostic-preferences'

const CURRENT_KEY = 'syrnike13:diagnostic-reports:v2'
const LEGACY_KEY = 'syrnike13:diagnostic-reports:v1'

describe('browser diagnostic preferences', () => {
  const values = new Map<string, string>()

  beforeEach(() => {
    values.clear()
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
})
