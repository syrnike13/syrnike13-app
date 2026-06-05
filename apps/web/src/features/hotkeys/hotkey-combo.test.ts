import { describe, expect, it } from 'vitest'

import {
  HOTKEY_ACTIONS,
  canRegisterHotkeyAction,
  comboDisplayLabel,
  comboFromNativeInputEvent,
  findDuplicateCombos,
  hotkeyMatchesNativeInput,
  shouldCaptureRecordedInput,
} from './hotkey-combo'

describe('hotkey combo helpers', () => {
  it('formats mouse and modifier combos for the settings UI', () => {
    expect(
      comboDisplayLabel({
        trigger: { type: 'mouse', button: 'Mouse5' },
        modifiers: { ctrl: false, alt: true, shift: false, meta: false },
      }),
    ).toBe('Alt+Mouse5')
  })

  it('formats modifier-only combos', () => {
    expect(
      comboDisplayLabel({
        trigger: { type: 'modifier', modifier: 'alt' },
        modifiers: { ctrl: false, alt: false, shift: false, meta: false },
      }),
    ).toBe('Alt')
  })

  it('builds combos from native input events', () => {
    expect(
      comboFromNativeInputEvent({
        type: 'mouseDown',
        button: 'Mouse5',
        modifiers: { ctrl: true, alt: false, shift: false, meta: false },
      }),
    ).toEqual({
      trigger: { type: 'mouse', button: 'Mouse5' },
      modifiers: { ctrl: true, alt: false, shift: false, meta: false },
    })
  })

  it('normalizes generic modifier codes from the native helper', () => {
    expect(
      comboFromNativeInputEvent({
        type: 'keyUp',
        code: 'Control',
        key: 'Control',
        modifiers: { ctrl: false, alt: false, shift: false, meta: false },
      }),
    ).toEqual({
      trigger: { type: 'modifier', modifier: 'ctrl' },
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
    })
  })

  it('waits for the non-modifier trigger while recording modifier combos', () => {
    expect(
      shouldCaptureRecordedInput({
        type: 'keyDown',
        code: 'Control',
        key: 'Control',
        modifiers: { ctrl: true, alt: false, shift: false, meta: false },
      }),
    ).toBe(false)

    expect(
      shouldCaptureRecordedInput({
        type: 'keyDown',
        code: 'KeyM',
        key: 'M',
        modifiers: { ctrl: true, alt: false, shift: false, meta: false },
      }),
    ).toBe(true)
  })

  it('captures modifier-only hotkeys on modifier release', () => {
    expect(
      shouldCaptureRecordedInput({
        type: 'keyUp',
        code: 'Alt',
        key: 'Alt',
        modifiers: { ctrl: false, alt: false, shift: false, meta: false },
      }),
    ).toBe(true)
  })

  it('matches exact trigger and modifier state', () => {
    const combo = {
      trigger: { type: 'mouse' as const, button: 'Mouse5' as const },
      modifiers: { ctrl: false, alt: true, shift: false, meta: false },
    }

    expect(
      hotkeyMatchesNativeInput(combo, {
        type: 'mouseDown',
        button: 'Mouse5',
        modifiers: { ctrl: false, alt: true, shift: false, meta: false },
      }),
    ).toBe(true)
    expect(
      hotkeyMatchesNativeInput(combo, {
        type: 'mouseDown',
        button: 'Mouse5',
        modifiers: { ctrl: true, alt: true, shift: false, meta: false },
      }),
    ).toBe(false)
  })

  it('finds duplicate enabled combos', () => {
    const combo = {
      trigger: { type: 'keyboard' as const, code: 'KeyM', key: 'M' },
      modifiers: { ctrl: true, alt: false, shift: true, meta: false },
    }

    expect(
      findDuplicateCombos([
        { id: 'a', action: 'toggle-mic', combo, enabled: true },
        { id: 'b', action: 'toggle-deafen', combo, enabled: true },
        { id: 'c', action: 'toggle-camera', combo, enabled: false },
      ]),
    ).toEqual(new Set(['a', 'b']))
  })

  it('enables hold actions once native down/up events exist', () => {
    const pushToTalk = HOTKEY_ACTIONS.find(
      (action) => action.id === 'push-to-talk',
    )

    expect(pushToTalk?.available).toBe(true)
    expect(canRegisterHotkeyAction('push-to-talk')).toBe(true)
  })
})
