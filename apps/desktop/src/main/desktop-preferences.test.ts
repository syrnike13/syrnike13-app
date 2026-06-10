import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_DESKTOP_PREFERENCES,
  loadDesktopPreferences,
  normalizeDesktopPreferences,
  saveDesktopPreferences,
} from './desktop-preferences'

describe('desktop preferences', () => {
  it('defaults close-to-tray to enabled', () => {
    expect(normalizeDesktopPreferences(undefined)).toEqual(
      DEFAULT_DESKTOP_PREFERENCES,
    )
  })

  it('keeps valid preference values from persisted data', () => {
    expect(
      normalizeDesktopPreferences({
        closeToTray: false,
        openAtLogin: false,
      }),
    ).toEqual({
      closeToTray: false,
      openAtLogin: false,
    })
  })

  it('defaults open-at-login to enabled when missing', () => {
    expect(normalizeDesktopPreferences({ closeToTray: false })).toEqual({
      closeToTray: false,
      openAtLogin: true,
    })
  })

  it('ignores invalid close-to-tray values', () => {
    expect(normalizeDesktopPreferences({ closeToTray: 'no' })).toEqual(
      DEFAULT_DESKTOP_PREFERENCES,
    )
  })

  it('loads and saves desktop preferences as json', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'syrnike-desktop-'))
    const filePath = path.join(dir, 'desktop-preferences.json')

    try {
      await saveDesktopPreferences(filePath, {
        closeToTray: false,
        openAtLogin: false,
      })

      expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
        closeToTray: false,
        openAtLogin: false,
      })
      expect(await loadDesktopPreferences(filePath)).toEqual({
        closeToTray: false,
        openAtLogin: false,
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
