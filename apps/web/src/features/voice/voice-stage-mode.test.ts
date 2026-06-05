import { describe, expect, it } from 'vitest'

import {
  nextStageLayoutModeForMediaClick,
  resolveStageLayoutMode,
} from '#/features/voice/voice-stage-mode'

describe('resolveStageLayoutMode', () => {
  it('keeps the requested grid mode even when a screen item is visible', () => {
    expect(
      resolveStageLayoutMode({
        requestedMode: 'grid',
        focusedMediaId: 'remote-user:screen',
        visibleMediaIds: ['remote-user:screen', 'local-user:camera'],
      }),
    ).toBe('grid')
  })

  it('falls back to grid when focus mode points at a missing media item', () => {
    expect(
      resolveStageLayoutMode({
        requestedMode: 'focus',
        focusedMediaId: 'remote-user:missing',
        visibleMediaIds: ['remote-user:screen', 'local-user:camera'],
      }),
    ).toBe('grid')
  })
})

describe('nextStageLayoutModeForMediaClick', () => {
  it('focuses the clicked media item from grid', () => {
    expect(
      nextStageLayoutModeForMediaClick({
        clickedMediaId: 'remote-user:screen',
        currentMode: 'grid',
        focusedMediaId: null,
      }),
    ).toEqual({
      mode: 'focus',
      focusedMediaId: 'remote-user:screen',
    })
  })

  it('returns to grid when the focused media item is clicked again', () => {
    expect(
      nextStageLayoutModeForMediaClick({
        clickedMediaId: 'remote-user:screen',
        currentMode: 'focus',
        focusedMediaId: 'remote-user:screen',
      }),
    ).toEqual({
      mode: 'grid',
      focusedMediaId: null,
    })
  })

  it('focuses another media item from focus mode', () => {
    expect(
      nextStageLayoutModeForMediaClick({
        clickedMediaId: 'remote-user:avatar',
        currentMode: 'focus',
        focusedMediaId: 'remote-user:screen',
      }),
    ).toEqual({
      mode: 'focus',
      focusedMediaId: 'remote-user:avatar',
    })
  })
})
