import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import { IPC } from '@syrnike13/platform'
import { NativeScreenPicker } from './media-runtime/native-screen-picker'
import type { MediaInventory } from './media-runtime/contract'
import type { MediaRuntimeSupervisor } from './media-runtime/media-runtime-supervisor'

vi.mock('electron', () => ({
  nativeImage: { createFromBitmap: () => ({ toDataURL: () => 'data:image/png;base64,preview' }) },
}))

import {
  displayMediaSourceTypeFromId,
  displayMediaSourcePage,
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

  it('returns one fixed-budget metadata page for 500 sources', () => {
    const sources = Array.from({ length: 500 }, (_, index) => ({ id: `${index}` }))

    expect(displayMediaSourcePage(sources, 10)).toEqual({
      sources: sources.slice(240, 264),
      page: 10,
      hasPrevious: true,
      hasNext: true,
    })
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

  it('does not retain the removed native picker path', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./media-permissions.ts', import.meta.url)),
      'utf8',
    )
    expect(source).not.toContain('getPendingNativePicker')
    expect(source).not.toContain('listNativeDisplaySourcePageEffect')
    expect(source).not.toContain('loadNativeDisplaySourceVisualEffect')
  })
})

function nativePickerFixture(count = 50) {
  let epoch = 1
  const inventory: MediaInventory = {
    microphoneMeter: { revision: 0, inputLevel: 0, gateThreshold: 0, gateOpen: false },
    audio: { revision: 1, status: 'ready', devices: [] },
    cameras: { revision: 1, status: 'ready', devices: [] },
    video: { revision: 1, publications: [] },
    sources: {
      revision: 1, complete: true, ok: true, truncated: false,
      entries: Array.from({ length: count }, (_, index) => ({
        id: `source-${index}`, kind: index === 0 ? 'monitor' : 'window',
        title: `Source ${index}`, label: '', available: true, minimized: false,
        audioAvailable: index !== 2, primary: index === 0,
      })),
    },
  }
  const queryThumbnail = vi.fn<MediaRuntimeSupervisor['queryThumbnail']>(async query => ({
    type: 'thumbnail', revision: query.revision, state: 'cancelled',
  }))
  const runtime = {
    start: async () => undefined,
    getHostEpoch: () => epoch,
    getSnapshot: vi.fn<MediaRuntimeSupervisor['getSnapshot']>(() => ({ status: 'ready', restartCount: 0 })),
    querySources: vi.fn<MediaRuntimeSupervisor['querySources']>(async query => ({
      type: 'sourcesQueryAccepted', revision: query.revision,
    })),
    queryInventory: vi.fn<MediaRuntimeSupervisor['queryInventory']>(async () => inventory),
    queryThumbnail,
  }
  const send = vi.fn()
  const picker = new NativeScreenPicker(runtime, () => ({ isDestroyed: () => false, webContents: { send } }))
  return { picker, runtime, inventory, send, restart: () => { epoch += 1 } }
}

describe('native screen picker', () => {
  it('pages metadata and only requests visuals from the visible page', async () => {
    const { picker, runtime } = nativePickerFixture()
    try {
      const request = picker.open(true)
      const page = await picker.sources(request.id, 1)
      expect(page.sources).toHaveLength(24)
      expect(page.sources[0]?.id).toBe('source-24')
      expect(page.hasPrevious && page.hasNext).toBe(true)
      expect(await picker.visual(request.id, 'source-0')).toBeNull()
      expect(runtime.queryThumbnail.mock.calls.every(([query]) => query.sourceId === null)).toBe(true)
    } finally { picker.dispose() }
  })

  it('waits for the native enumeration revision to be published', async () => {
    const { picker, runtime, inventory } = nativePickerFixture()
    runtime.queryInventory.mockResolvedValueOnce({
      ...inventory, sources: { ...inventory.sources, revision: 0, entries: [] },
    })
    try {
      const request = picker.open(false)
      expect((await picker.sources(request.id, 0)).sources).toHaveLength(24)
      expect(runtime.queryInventory).toHaveBeenCalledTimes(2)
    } finally { picker.dispose() }
  })

  it('shows a completed truncated catalog and reports enumeration failure without waiting', async () => {
    const { picker, runtime, inventory } = nativePickerFixture()
    runtime.queryInventory.mockResolvedValueOnce({
      ...inventory, sources: { ...inventory.sources, complete: false, truncated: true },
    })
    try {
      const request = picker.open(false)
      expect((await picker.sources(request.id, 0)).sources).toHaveLength(24)
      runtime.queryInventory.mockResolvedValueOnce({
        ...inventory, sources: { ...inventory.sources, revision: 2, complete: false, ok: false, entries: [] },
      })
      const failed = picker.open(false)
      await expect(picker.sources(failed.id, 0)).rejects.toThrow('could not be enumerated')
      expect(runtime.queryInventory).toHaveBeenCalledTimes(2)
    } finally { picker.dispose() }
  })

  it('deduplicates requests and drops in-flight and queued thumbnails after page replacement', async () => {
    const { picker, runtime } = nativePickerFixture()
    let release: (result: Awaited<ReturnType<MediaRuntimeSupervisor['queryThumbnail']>>) => void = () => {}
    try {
      const request = picker.open(false)
      await picker.sources(request.id, 0)
      runtime.queryThumbnail.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      const first = picker.visual(request.id, 'source-0')
      expect(picker.visual(request.id, 'source-0')).toBe(first)
      const queued = picker.visual(request.id, 'source-1')
      const revision = runtime.queryThumbnail.mock.lastCall?.[0].revision ?? 0
      await picker.sources(request.id, 1)
      expect(await queued).toBeNull()
      release({ type: 'thumbnail', revision, state: 'ready', pixels: new Uint8Array(320 * 180 * 4) })
      expect(await first).toBeNull()
      expect(runtime.queryThumbnail.mock.calls.filter(([query]) => query.sourceId !== null)).toHaveLength(1)
    } finally { picker.dispose() }
  })

  it('rejects selection after host replacement and ignores stale request cancellation', async () => {
    const { picker, restart, send } = nativePickerFixture()
    try {
      const old = picker.open(true)
      const request = picker.open(true)
      picker.cancel(old.id)
      await picker.sources(request.id, 0)
      restart()
      expect(picker.select(request.id, 'source-0')).toBe(false)
      expect(await picker.visual(request.id, 'source-0')).toBeNull()
      expect(send.mock.calls.some(([channel]) => channel === IPC.mediaDisplayPickerResolved)).toBe(false)
    } finally { picker.dispose() }
  })

  it.each([
    ['source-0', 'system', true],
    ['source-1', 'process', true],
    ['source-2', 'process', false],
  ])('resolves %s with supported audio intent through the director event', async (sourceId, audioMode, audioRequested) => {
    const { picker, send } = nativePickerFixture()
    try {
      const request = picker.open(true)
      await picker.sources(request.id, 0)
      expect(picker.select(request.id, sourceId)).toBe(true)
      expect(send).toHaveBeenCalledWith(IPC.mediaDisplayPickerResolved, {
        requestId: request.id, sourceId, audioMode, audioRequested,
      })
      expect(picker.select(request.id, sourceId)).toBe(false)
    } finally { picker.dispose() }
  })
})
