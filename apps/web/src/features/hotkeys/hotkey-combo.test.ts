import { describe, expect, it } from 'vitest'

import {
  HOTKEY_ACTIONS,
  canRegisterHotkeyAction,
  comboDisplayLabel,
  comboFromNativeInputEvent,
  comboFromRecordedInputs,
  findDuplicateCombos,
  hotkeyMatchesNativeInput,
  shouldCaptureRecordedInput,
} from './hotkey-combo'

describe('hotkey combo helpers', () => {
  it('formats physical combos for the settings UI', () => {
    expect(
      comboDisplayLabel({
        codes: ['AltLeft', 'Mouse5'],
      }),
    ).toBe('Left Alt+Mouse5')
  })

  it('formats left and right modifiers separately', () => {
    expect(
      comboDisplayLabel({
        codes: ['ControlLeft', 'ControlRight'],
      }),
    ).toBe('Left Ctrl+Right Ctrl')
  })

  it('builds combos from native pressed codes', () => {
    expect(
      comboFromNativeInputEvent({
        type: 'inputDown',
        source: 'mouse',
        code: 'Mouse5',
        label: 'Mouse5',
        pressedCodes: ['ControlRight', 'Mouse5'],
      }),
    ).toEqual({
      codes: ['ControlRight', 'Mouse5'],
    })
  })

  it('captures modifier-only hotkeys on release', () => {
    expect(
      shouldCaptureRecordedInput({
        type: 'inputUp',
        source: 'keyboard',
        code: 'ControlRight',
        label: 'Right Ctrl',
        pressedCodes: [],
      }),
    ).toBe(true)
  })

  it('matches exact physical code set', () => {
    const combo = {
      codes: ['AltLeft', 'Mouse5'],
    }

    expect(
      hotkeyMatchesNativeInput(combo, {
        type: 'inputDown',
        source: 'mouse',
        code: 'Mouse5',
        label: 'Mouse5',
        pressedCodes: ['AltLeft', 'Mouse5'],
      }),
    ).toBe(true)
    expect(
      hotkeyMatchesNativeInput(combo, {
        type: 'inputDown',
        source: 'mouse',
        code: 'Mouse5',
        label: 'Mouse5',
        pressedCodes: ['AltLeft', 'ControlRight', 'Mouse5'],
      }),
    ).toBe(false)
  })

  it('records the last non-empty chord when the first key is released', () => {
    expect(
      comboFromRecordedInputs([
        {
          type: 'inputDown',
          source: 'keyboard',
          code: 'ControlRight',
          label: 'Right Ctrl',
          pressedCodes: ['ControlRight'],
        },
        {
          type: 'inputDown',
          source: 'keyboard',
          code: 'KeyM',
          label: 'M',
          pressedCodes: ['ControlRight', 'KeyM'],
        },
        {
          type: 'inputUp',
          source: 'keyboard',
          code: 'KeyM',
          label: 'M',
          pressedCodes: ['ControlRight'],
        },
      ]),
    ).toEqual({ codes: ['ControlRight', 'KeyM'] })
  })

  it('records only keys pressed after recording starts', () => {
    expect(
      comboFromRecordedInputs([
        {
          type: 'inputDown',
          source: 'keyboard',
          code: 'ControlRight',
          label: 'Right Ctrl',
          pressedCodes: ['ControlRight', 'MetaLeft', 'Space'],
        },
        {
          type: 'inputUp',
          source: 'keyboard',
          code: 'ControlRight',
          label: 'Right Ctrl',
          pressedCodes: ['MetaLeft', 'Space'],
        },
      ]),
    ).toEqual({ codes: ['ControlRight'] })
  })

  it('finds duplicate enabled combos', () => {
    const combo = {
      codes: ['ControlLeft', 'KeyM'],
    }

    expect(
      findDuplicateCombos([
        { id: 'a', action: 'toggle-mic', combo, enabled: true },
        { id: 'b', action: 'toggle-deafen', combo, enabled: true },
        { id: 'c', action: 'toggle-camera', combo, enabled: false },
      ]),
    ).toEqual(new Set(['a', 'b']))
  })

  it('does not treat left and right control combos as duplicates', () => {
    expect(
      findDuplicateCombos([
        {
          id: 'left',
          action: 'toggle-mic',
          combo: { codes: ['ControlLeft', 'KeyM'] },
          enabled: true,
        },
        {
          id: 'right',
          action: 'toggle-deafen',
          combo: { codes: ['ControlRight', 'KeyM'] },
          enabled: true,
        },
      ]),
    ).toEqual(new Set())
  })

  it('enables hold actions once native down/up events exist', () => {
    const pushToTalk = HOTKEY_ACTIONS.find(
      (action) => action.id === 'push-to-talk',
    )

    expect(pushToTalk?.available).toBe(true)
    expect(canRegisterHotkeyAction('push-to-talk')).toBe(true)
  })
})
