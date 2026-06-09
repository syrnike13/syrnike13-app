import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  displayMediaSourceTypeFromId,
  isAllowedMediaOrigin,
  shouldGrantDesktopMediaPermission,
  shouldAllowBrowserDisplayMediaFallback,
} from './media-permissions'

describe('desktop media permissions', () => {
  it('grants media only to the app origin', () => {
    const appUrl = 'http://127.0.0.1:31415'

    expect(
      shouldGrantDesktopMediaPermission(
        appUrl,
        'media',
        'http://127.0.0.1:31415/app',
      ),
    ).toBe(true)
    expect(
      shouldGrantDesktopMediaPermission(
        appUrl,
        'media',
        'https://syrnike13.ru/app',
      ),
    ).toBe(false)
    expect(
      shouldGrantDesktopMediaPermission(
        appUrl,
        'notifications',
        'http://127.0.0.1:31415/app',
      ),
    ).toBe(false)
  })

  it('rejects malformed media origins', () => {
    expect(isAllowedMediaOrigin('http://127.0.0.1:3000', 'not a url')).toBe(
      false,
    )
  })

  it('maps desktop capturer ids to picker source types', () => {
    expect(displayMediaSourceTypeFromId('screen:0:0')).toBe('screen')
    expect(displayMediaSourceTypeFromId('game:1234')).toBe('game')
    expect(displayMediaSourceTypeFromId('window:12:0')).toBe('window')
  })

  it('disables browser display media fallback on Windows desktop', () => {
    expect(shouldAllowBrowserDisplayMediaFallback('win32')).toBe(false)
    expect(shouldAllowBrowserDisplayMediaFallback('darwin')).toBe(true)
    expect(shouldAllowBrowserDisplayMediaFallback('linux')).toBe(true)
  })

  it('short-circuits browser display media requests on Windows before creating a browser picker request', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./media-permissions.ts', import.meta.url)),
      'utf8',
    )
    const displayHandlerBody = source.match(
      /session\.defaultSession\.setDisplayMediaRequestHandler\(\(request, callback\) => \{[\s\S]*?\r?\n  \}\)/,
    )?.[0]

    expect(displayHandlerBody).toBeDefined()
    const fallbackGuardIndex = displayHandlerBody?.indexOf(
      'shouldAllowBrowserDisplayMediaFallback(process.platform)',
    )
    const callbackIndex = displayHandlerBody?.indexOf('callback({})')
    const browserRequestIndex = displayHandlerBody?.indexOf('nativeVideo: false')

    expect(fallbackGuardIndex).toBeGreaterThanOrEqual(0)
    expect(callbackIndex).toBeGreaterThan(fallbackGuardIndex ?? -1)
    expect(browserRequestIndex).toBeGreaterThan(callbackIndex ?? -1)
  })

  it('loads native picker sources from the native helper', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./media-permissions.ts', import.meta.url)),
      'utf8',
    )
    const nativeRefreshBody = source.match(
      /async function refreshPendingNativePickerSources[\s\S]*?\r?\n}\r?\n\r?\nfunction selectPendingDisplayMediaSource/,
    )?.[0]

    expect(nativeRefreshBody).toBeDefined()
    expect(nativeRefreshBody).toContain('listNativeDisplaySources(getWindow)')
    expect(nativeRefreshBody).not.toContain('loadSourcesForRequest')
  })

  it('returns selected native picker audio preference to the renderer', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./media-permissions.ts', import.meta.url)),
      'utf8',
    )
    const selectBody = source.match(
      /ipcMain\.handle\(\s*IPC\.mediaSelectDisplaySource[\s\S]*?return selectPendingDisplayMediaSource/,
    )?.[0]

    expect(selectBody).toBeDefined()
    expect(selectBody).toContain('audioRequested')
    expect(selectBody).toContain('nativePending.audioRequested')
    expect(selectBody).toContain('source.audioAvailable !== false')
  })
})
