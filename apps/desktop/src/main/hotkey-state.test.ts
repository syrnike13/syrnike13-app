import { describe, expect, it } from 'vitest'
import type {
  HotkeyBinding,
  HotkeyModifiers,
  NativeInputEvent,
} from '@syrnike13/platform'

import { HotkeyState } from './hotkey-state'

const ctrlM: HotkeyBinding = {
  id: 'ctrl-m',
  action: 'push-to-talk',
  enabled: true,
  combo: {
    trigger: { type: 'keyboard', code: 'KeyM', key: 'M' },
    modifiers: { ctrl: true, alt: false, shift: false, meta: false },
  },
}

describe('desktop hotkey state', () => {
  it('releases a held combo after the modifier was released first', () => {
    const state = new HotkeyState()

    expect(state.handleInput(keyDown('KeyM', 'M', { ctrl: true }), [ctrlM])).toEqual([
      { action: 'push-to-talk', phase: 'pressed' },
    ])

    expect(state.handleInput(keyUp('Control', 'Control'), [ctrlM])).toEqual([])
    expect(state.handleInput(keyUp('KeyM', 'M'), [ctrlM])).toEqual([
      { action: 'push-to-talk', phase: 'released' },
    ])

    expect(state.handleInput(keyDown('KeyM', 'M', { ctrl: true }), [ctrlM])).toEqual([
      { action: 'push-to-talk', phase: 'pressed' },
    ])
  })

  it('releases held hold-actions when suspended', () => {
    const state = new HotkeyState()

    state.handleInput(keyDown('KeyM', 'M', { ctrl: true }), [ctrlM])

    expect(state.releaseHeldActions()).toEqual([
      { action: 'push-to-talk', phase: 'released' },
    ])
    expect(state.releaseHeldActions()).toEqual([])
  })
})

function keyDown(
  code: string,
  key: string,
  modifiers: Partial<HotkeyModifiers> = {},
): NativeInputEvent {
  return {
    type: 'keyDown',
    code,
    key,
    modifiers: {
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
      ...modifiers,
    },
  }
}

function keyUp(
  code: string,
  key: string,
  modifiers: Partial<HotkeyModifiers> = {},
): NativeInputEvent {
  return {
    type: 'keyUp',
    code,
    key,
    modifiers: {
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
      ...modifiers,
    },
  }
}
