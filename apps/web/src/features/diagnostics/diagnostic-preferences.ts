const STORAGE_KEY = 'syrnike13:diagnostic-reports:v1'

export function readBrowserDiagnosticReportsEnabled() {
  if (typeof localStorage === 'undefined') return false
  try {
    return localStorage.getItem(STORAGE_KEY) === 'enabled'
  } catch {
    return false
  }
}

export function writeBrowserDiagnosticReportsEnabled(enabled: boolean) {
  if (typeof localStorage === 'undefined') return
  try {
    if (enabled) localStorage.setItem(STORAGE_KEY, 'enabled')
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Diagnostics preferences must never affect application behavior.
  }
}
