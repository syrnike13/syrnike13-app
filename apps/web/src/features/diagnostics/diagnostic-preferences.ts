const STORAGE_KEY = 'syrnike13:diagnostic-reports:v2'
const LEGACY_STORAGE_KEY = 'syrnike13:diagnostic-reports:v1'
const ENABLED = 'enabled'
const DISABLED = 'disabled'

let volatilePreference: boolean | null = null

export function readBrowserDiagnosticReportsEnabled() {
  if (volatilePreference !== null) return volatilePreference
  if (typeof localStorage === 'undefined') return false
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === ENABLED) return true
    if (stored === DISABLED) return false

    // v2 is a one-time default-on migration. It deliberately enables reports
    // for existing browsers, including browsers that used the v1 opt-in key;
    // subsequent v2 opt-outs remain durable.
    localStorage.setItem(STORAGE_KEY, ENABLED)
    localStorage.removeItem(LEGACY_STORAGE_KEY)
    return true
  } catch {
    return false
  }
}

export function writeBrowserDiagnosticReportsEnabled(enabled: boolean) {
  volatilePreference = enabled
  if (typeof localStorage === 'undefined') return false
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? ENABLED : DISABLED)
    volatilePreference = null
    return true
  } catch {
    return false
  }
}

export function resetBrowserDiagnosticPreferenceForTests() {
  volatilePreference = null
}
