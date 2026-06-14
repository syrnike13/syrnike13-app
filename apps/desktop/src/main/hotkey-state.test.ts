import { describe, expect, it } from 'vitest'
import type { HotkeyBinding, NativeInputEvent } from '@syrnike13/platform'

import { HotkeyState } from './hotkey-state'

const ctrlM: HotkeyBinding = {
  id: 'ctrl-m',
  action: 'push-to-talk',
  enabled: true,
  combo: {
    codes: ['ControlRight', 'KeyM'],
  },
}

describe('desktop hotkey state', () => {
  it('matches exact physical combo codes', () => {
    const state = new HotkeyState()

    expect(
      state.handleInput(inputDown('KeyM', 'M', ['ControlLeft', 'KeyM']), [ctrlM]),
    ).toEqual([])

    expect(
      state.handleInput(inputDown('KeyM', 'M', ['ControlRight', 'KeyM']), [ctrlM]),
    ).toEqual([{ action: 'push-to-talk', phase: 'pressed' }])
  })

  it('matches a combo when unrelated keys were pressed before activation', () => {
    const state = new HotkeyState()

    expect(
      state.handleInput(
        inputDown('KeyM', 'M', ['ControlRight', 'KeyA', 'KeyM', 'ShiftLeft']),
        [ctrlM],
      ),
    ).toEqual([{ action: 'push-to-talk', phase: 'pressed' }])
  })

  it('prefers the most specific matching combo', () => {
    const state = new HotkeyState()
    const ctrlShiftM: HotkeyBinding = {
      id: 'ctrl-shift-m',
      action: 'toggle-mic',
      enabled: true,
      combo: {
        codes: ['ControlRight', 'KeyM', 'ShiftLeft'],
      },
    }

    expect(
      state.handleInput(
        inputDown('KeyM', 'M', ['ControlRight', 'KeyM', 'ShiftLeft']),
        [ctrlM, ctrlShiftM],
      ),
    ).toEqual([{ action: 'toggle-mic', phase: 'pressed' }])
  })

  it('keeps an active hold while extra keys are pressed after activation', () => {
    const state = new HotkeyState()

    expect(
      state.handleInput(inputDown('KeyM', 'M', ['ControlRight', 'KeyM']), [ctrlM]),
    ).toEqual([{ action: 'push-to-talk', phase: 'pressed' }])

    expect(
      state.handleInput(
        inputDown('ShiftLeft', 'Shift', ['ControlRight', 'KeyM', 'ShiftLeft']),
        [ctrlM],
      ),
    ).toEqual([])

    expect(
      state.handleInput(inputUp('ShiftLeft', 'Shift', ['ControlRight', 'KeyM']), [
        ctrlM,
      ]),
    ).toEqual([])

    expect(
      state.handleInput(inputUp('KeyM', 'M', ['ControlRight']), [ctrlM]),
    ).toEqual([{ action: 'push-to-talk', phase: 'released' }])
  })

  it('fires toggle actions once until the combo is released', () => {
    const state = new HotkeyState()
    const binding: HotkeyBinding = {
      id: 'toggle-camera',
      action: 'toggle-camera',
      enabled: true,
      combo: { codes: ['ControlRight', 'KeyC'] },
    }

    expect(
      state.handleInput(inputDown('KeyC', 'C', ['ControlRight', 'KeyC']), [
        binding,
      ]),
    ).toEqual([{ action: 'toggle-camera', phase: 'pressed' }])

    expect(
      state.handleInput(inputDown('KeyC', 'C', ['ControlRight', 'KeyC']), [
        binding,
      ]),
    ).toEqual([])

    expect(
      state.handleInput(inputUp('KeyC', 'C', ['ControlRight']), [binding]),
    ).toEqual([])

    expect(
      state.handleInput(inputDown('KeyC', 'C', ['ControlRight', 'KeyC']), [
        binding,
      ]),
    ).toEqual([{ action: 'toggle-camera', phase: 'pressed' }])
  })

  it('releases held hold-actions when suspended', () => {
    const state = new HotkeyState()

    state.handleInput(inputDown('KeyM', 'M', ['ControlRight', 'KeyM']), [ctrlM])

    expect(state.releaseHeldActions()).toEqual([
      { action: 'push-to-talk', phase: 'released' },
    ])
    expect(state.releaseHeldActions()).toEqual([])
  })
})

function inputDown(
  code: string,
  label: string,
  pressedCodes: string[],
): NativeInputEvent {
  return {
    type: 'inputDown',
    source: code.startsWith('Mouse') ? 'mouse' : 'keyboard',
    code,
    label,
    pressedCodes,
  }
}

function inputUp(
  code: string,
  label: string,
  pressedCodes: string[],
): NativeInputEvent {
  return {
    type: 'inputUp',
    source: code.startsWith('Mouse') ? 'mouse' : 'keyboard',
    code,
    label,
    pressedCodes,
  }
}
