import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import {
  clearDesktopSession,
  loadDesktopSession,
  saveDesktopSession,
} from './desktop-session'

describe('desktop session storage', () => {
  it('persists and clears a session in an app-owned file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'syrnike-session-'))
    const filePath = join(dir, 'session.json')

    try {
      const session = {
        _id: 'session-1',
        token: 'token-1',
        user_id: 'user-1',
      }

      await saveDesktopSession(filePath, session)
      await expect(loadDesktopSession(filePath)).resolves.toEqual(session)

      await clearDesktopSession(filePath)
      await expect(loadDesktopSession(filePath)).resolves.toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
