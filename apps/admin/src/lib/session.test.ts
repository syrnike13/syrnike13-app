// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'

import { clearSession, loadSession, saveSession } from './session'

const SESSION_KEY = 'syrnike13:admin:session'

describe('admin session persistence', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('round-trips a valid stored session', () => {
    const session = {
      _id: 'session-1',
      token: 'secret-token',
      user_id: 'user-1',
    }

    saveSession(session)

    expect(loadSession()).toEqual(session)
  })

  it('rejects malformed JSON and invalid stored values', () => {
    localStorage.setItem(SESSION_KEY, '{invalid-json')
    expect(loadSession()).toBeNull()

    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        _id: 'session-1',
        token: 42,
        user_id: 'user-1',
      }),
    )
    expect(loadSession()).toBeNull()
  })

  it('clears the stored session', () => {
    saveSession({
      _id: 'session-1',
      token: 'secret-token',
      user_id: 'user-1',
    })

    clearSession()

    expect(localStorage.getItem(SESSION_KEY)).toBeNull()
  })
})
