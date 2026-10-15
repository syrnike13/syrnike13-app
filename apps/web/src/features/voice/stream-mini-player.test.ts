import { describe, expect, it } from 'vitest'
import type { VoiceStageMediaItem } from './voice-context'
import {
  clampMiniPlayerPosition,
  miniPlayerCornerPosition,
  miniPlayerVisible,
  miniPlayerWidth,
  selectMiniPlayerStream,
} from './stream-mini-player'
import { nearestFloatingCorner } from '#/lib/floating-corner'

describe('mini player visibility', () => {
  const base = {
    hasStream: true,
    sessionChannelId: 'voice',
    routeChannelId: 'text',
    stageMounted: false,
    popoutOpen: false,
    fullscreen: false,
  }
  it('shows outside the active stage, including same-channel text mode', () => {
    expect(miniPlayerVisible(base)).toBe(true)
    expect(miniPlayerVisible({ ...base, routeChannelId: 'voice' })).toBe(true)
    expect(
      miniPlayerVisible({
        ...base,
        routeChannelId: 'voice',
        stageMounted: true,
      }),
    ).toBe(false)
    expect(miniPlayerVisible({ ...base, stageMounted: true })).toBe(true)
  })
  it('hides without a stream/session, in popout, or in fullscreen', () => {
    expect(miniPlayerVisible({ ...base, hasStream: false })).toBe(false)
    expect(miniPlayerVisible({ ...base, sessionChannelId: null })).toBe(false)
    expect(miniPlayerVisible({ ...base, popoutOpen: true })).toBe(false)
    expect(miniPlayerVisible({ ...base, fullscreen: true })).toBe(false)
  })
})

it('selects focused watched screen, first watched screen, then own preview', () => {
  const own: VoiceStageMediaItem = {
    id: 'own:screen',
    userId: 'own',
    kind: 'screen',
    isLocal: true,
    live: true,
  }
  const first: VoiceStageMediaItem = {
    id: 'a:screen',
    userId: 'a',
    kind: 'screen',
    isLocal: false,
    live: true,
  }
  const second: VoiceStageMediaItem = {
    id: 'b:screen',
    userId: 'b',
    kind: 'screen',
    isLocal: false,
    live: true,
  }
  const items = [own, first, second]
  expect(selectMiniPlayerStream(items, [first.id, second.id], second.id)).toBe(
    second,
  )
  expect(selectMiniPlayerStream(items, [first.id, second.id], 'other')).toBe(
    first,
  )
  expect(selectMiniPlayerStream(items, [], second.id)).toBe(own)
  expect(selectMiniPlayerStream([first, second], [], null)).toBeNull()
})

describe('mini player geometry', () => {
  const viewport = { width: 1280, height: 800 }
  it('caps size at 480px, 40% of viewport, and available height', () => {
    expect(miniPlayerWidth(800, viewport)).toBe(480)
    expect(miniPlayerWidth(100, viewport)).toBe(240)
    expect(miniPlayerWidth(480, { width: 800, height: 600 })).toBe(320)
    expect(miniPlayerWidth(480, { width: 400, height: 300 })).toBe(160)
    expect(miniPlayerWidth(NaN, viewport)).toBe(320)
    expect(miniPlayerWidth(480, { width: 1280, height: 200 })).toBeCloseTo(
      (136 * 16) / 9,
    )
  })
  it('clamps dragging inside the viewport and reserves space above the voice panel', () => {
    expect(clampMiniPlayerPosition(-100, -100, 320, viewport)).toEqual({
      x: 8,
      y: 48,
    })
    expect(clampMiniPlayerPosition(1500, 1000, 320, viewport)).toEqual({
      x: 952,
      y: 612,
    })
    expect(miniPlayerCornerPosition('bottom-left', 320, viewport)).toEqual({
      x: 16,
      y: 428,
    })
    expect(miniPlayerCornerPosition('top-right', 320, viewport)).toEqual({
      x: 944,
      y: 48,
    })
    expect(miniPlayerCornerPosition('bottom-right', 320, viewport)).toEqual({
      x: 944,
      y: 524,
    })
    expect(nearestFloatingCorner(100, 700, 1280, 800)).toBe('bottom-left')
    expect(nearestFloatingCorner(1200, 100, 1280, 800)).toBe('top-right')
  })
})
