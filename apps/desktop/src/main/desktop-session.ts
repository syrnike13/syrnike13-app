import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { DesktopStoredSession } from '@syrnike13/platform'

const SESSION_FILE = 'session.json'

export function desktopSessionPath(userDataPath: string) {
  return path.join(userDataPath, SESSION_FILE)
}

function isStoredSession(value: unknown): value is DesktopStoredSession {
  if (!value || typeof value !== 'object') return false
  const session = value as DesktopStoredSession
  return (
    typeof session._id === 'string' &&
    typeof session.token === 'string' &&
    typeof session.user_id === 'string' &&
    session._id.length > 0 &&
    session.token.length > 0 &&
    session.user_id.length > 0
  )
}

export async function loadDesktopSession(filePath: string) {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return isStoredSession(parsed) ? parsed : null
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return null
    }
    throw error
  }
}

export async function saveDesktopSession(
  filePath: string,
  session: DesktopStoredSession,
) {
  if (!isStoredSession(session)) {
    throw new Error('Invalid desktop session payload')
  }
  await writeFile(filePath, JSON.stringify(session), { mode: 0o600 })
}

export async function clearDesktopSession(filePath: string) {
  await rm(filePath, { force: true })
}
