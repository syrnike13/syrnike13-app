// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Effect, Fiber } from 'effect'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  DesktopDisplayMediaRequest,
  DesktopDisplayMediaSource,
  DesktopDisplayMediaSourcePage,
} from '@syrnike13/platform'

type PickerDesktop = {
  media: {
    onRequest: (
      handler: (request: DesktopDisplayMediaRequest) => void,
    ) => () => void
    getDisplaySources: (
      requestId: string,
      page: number,
    ) => Promise<DesktopDisplayMediaSourcePage>
    getDisplaySourceVisual: (
      requestId: string,
      sourceId: string,
    ) => Promise<DesktopDisplayMediaSource | null>
    selectDisplaySource: (
      requestId: string,
      sourceId: string,
      audioRequested?: boolean,
    ) => Promise<boolean>
    cancelRequest: (requestId: string) => Promise<void>
  }
}

const platform = vi.hoisted<{
  desktop: PickerDesktop | null
  requestHandler: ((request: DesktopDisplayMediaRequest) => void) | null
}>(() => ({ desktop: null, requestHandler: null }))

vi.mock('#/platform/use-platform', () => ({
  usePlatform: () => ({ desktop: platform.desktop }),
}))

import {
  canRequestSourceAudio,
  DISPLAY_SOURCE_VISUAL_CONCURRENCY,
  DesktopScreenSharePicker,
  loadDisplaySourceVisualsEffect,
  sourceAudioLabel,
} from './desktop-screen-share-picker'

afterEach(() => {
  cleanup()
  platform.desktop = null
  platform.requestHandler = null
})

function source(
  type: DesktopDisplayMediaSource['type'],
  fields: Partial<DesktopDisplayMediaSource> = {},
): DesktopDisplayMediaSource {
  return {
    id: `${type}:1`,
    name: type,
    type,
    thumbnailDataUrl: null,
    appIconDataUrl: null,
    ...fields,
  }
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition was not reached')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

describe('desktop screen share picker audio contract', () => {
  it('labels source-specific native audio modes', () => {
    expect(sourceAudioLabel(source('screen'))).toBe(
      'Системный звук без приложения',
    )
    expect(sourceAudioLabel(source('game'))).toBe('Звук только игры')
    expect(sourceAudioLabel(source('window'))).toBe('Звук только окна')
  })

  it('does not allow audio for sources without native audio support', () => {
    const unavailableWindow = source('window', {
      audioAvailable: false,
      audioMode: 'none',
    })

    expect(sourceAudioLabel(unavailableWindow)).toBe('Звук недоступен')
    expect(canRequestSourceAudio(unavailableWindow)).toBe(false)
  })
})

describe('desktop screen share picker visual budget', () => {
  it('caps a 500-source input to one page and four concurrent visual requests', async () => {
    const sources = Array.from({ length: 500 }, (_, index) =>
      source('window', { id: `window:${index + 1}` }),
    )
    let active = 0
    let maximumActive = 0
    const loadVisual = vi.fn(async (_requestId: string, sourceId: string) => {
      ++active
      maximumActive = Math.max(maximumActive, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      --active
      return source('window', {
        id: sourceId,
        thumbnailDataUrl: 'data:image/bmp;base64,preview',
      })
    })
    const onVisual = vi.fn()

    await Effect.runPromise(loadDisplaySourceVisualsEffect({
      requestId: 'picker-1',
      sources,
      loadVisual,
      isCurrent: () => true,
      onVisual,
    }))

    expect(loadVisual).toHaveBeenCalledTimes(24)
    expect(maximumActive).toBe(DISPLAY_SOURCE_VISUAL_CONCURRENCY)
    expect(onVisual).toHaveBeenCalledTimes(24)
  })

  it('drops late visuals after cancellation or a newer enumeration', async () => {
    const pending: Array<{
      sourceId: string
      resolve: (visual: DesktopDisplayMediaSource | null) => void
    }> = []
    let current = true
    const onVisual = vi.fn()
    const fiber = Effect.runFork(loadDisplaySourceVisualsEffect({
      requestId: 'old-picker',
      sources: Array.from({ length: 24 }, (_, index) =>
        source('window', { id: `window:${index + 1}` }),
      ),
      loadVisual: (_requestId, sourceId) =>
        new Promise((resolve) => pending.push({ sourceId, resolve })),
      isCurrent: () => current,
      onVisual,
    }))
    await waitUntil(() => pending.length === DISPLAY_SOURCE_VISUAL_CONCURRENCY)

    current = false
    await Effect.runPromise(Fiber.interrupt(fiber))
    for (const request of pending) {
      request.resolve(source('window', {
        id: request.sourceId,
        thumbnailDataUrl: 'data:image/bmp;base64,late',
      }))
    }
    await Promise.resolve()

    expect(onVisual).not.toHaveBeenCalled()
    expect(pending).toHaveLength(DISPLAY_SOURCE_VISUAL_CONCURRENCY)
  })
})

describe('desktop screen share picker paging UI', () => {
  it('keeps the normal one-page picker behavior and loads visuals lazily', async () => {
    const metadata = source('screen', { id: 'screen:1', name: 'Primary screen' })
    const getDisplaySources = vi.fn(async () => ({
      sources: [metadata],
      page: 0,
      hasPrevious: false,
      hasNext: false,
    }))
    const getDisplaySourceVisual = vi.fn(async () => ({
      ...metadata,
      thumbnailDataUrl: 'data:image/bmp;base64,preview',
    }))
    platform.desktop = {
      media: {
        onRequest: (handler) => {
          platform.requestHandler = handler
          return () => undefined
        },
        getDisplaySources,
        getDisplaySourceVisual,
        selectDisplaySource: vi.fn(async () => true),
        cancelRequest: vi.fn(async () => undefined),
      },
    }

    render(createElement(DesktopScreenSharePicker))
    act(() => {
      platform.requestHandler?.({
        id: 'picker-1',
        audioRequested: true,
        nativeVideo: true,
      })
    })

    await waitFor(() => expect(screen.getByText('Primary screen')).not.toBeNull())
    expect(getDisplaySources).toHaveBeenCalledWith('picker-1', 0)
    await waitFor(() => expect(getDisplaySourceVisual).toHaveBeenCalledWith(
      'picker-1',
      'screen:1',
    ))
    expect(screen.queryByRole('button', { name: 'Назад' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Далее' })).toBeNull()
  })

  it('replaces the current page instead of accumulating source metadata', async () => {
    const first = source('screen', { id: 'screen:1', name: 'First page' })
    const second = source('window', { id: 'window:2', name: 'Second page' })
    const getDisplaySources = vi.fn(async (_requestId: string, page: number) => ({
      sources: [page === 0 ? first : second],
      page,
      hasPrevious: page > 0,
      hasNext: page === 0,
    }))
    platform.desktop = {
      media: {
        onRequest: (handler) => {
          platform.requestHandler = handler
          return () => undefined
        },
        getDisplaySources,
        getDisplaySourceVisual: vi.fn(async () => null),
        selectDisplaySource: vi.fn(async () => true),
        cancelRequest: vi.fn(async () => undefined),
      },
    }

    render(createElement(DesktopScreenSharePicker))
    act(() => {
      platform.requestHandler?.({
        id: 'picker-2',
        audioRequested: false,
        nativeVideo: true,
      })
    })
    await waitFor(() => expect(screen.getByText('First page')).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Далее' }))

    await waitFor(() => expect(screen.getByText('Second page')).not.toBeNull())
    expect(screen.queryByText('First page')).toBeNull()
    expect(getDisplaySources).toHaveBeenLastCalledWith('picker-2', 1)
  })
})
