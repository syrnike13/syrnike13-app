const SESSION_KEY = 'syrnike13:session'

export type StoredSession = {
  _id: string
  token: string
  user_id: string
}

export function loadSession(): StoredSession | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    return JSON.parse(raw) as StoredSession
  } catch {
    return null
  }
}

export async function loadPersistedSession(): Promise<StoredSession | null> {
  if (
    typeof window !== 'undefined' &&
    window.syrnikeDesktop?.runtime === 'desktop'
  ) {
    return window.syrnikeDesktop.auth.loadSession()
  }

  return loadSession()
}

export async function saveSession(session: StoredSession) {
  if (
    typeof window !== 'undefined' &&
    window.syrnikeDesktop?.runtime === 'desktop'
  ) {
    await window.syrnikeDesktop.auth.saveSession(session)
    return
  }

  localStorage.setItem(SESSION_KEY, JSON.stringify(session))
}

export async function clearSession() {
  if (
    typeof window !== 'undefined' &&
    window.syrnikeDesktop?.runtime === 'desktop'
  ) {
    await window.syrnikeDesktop.auth.clearSession()
    return
  }

  localStorage.removeItem(SESSION_KEY)
}
