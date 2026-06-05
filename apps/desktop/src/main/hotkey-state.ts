import type {
  HotkeyAction,
  HotkeyActivationEvent,
  HotkeyBinding,
  HotkeyCombo,
  HotkeyModifier,
  NativeInputEvent,
} from '@syrnike13/platform'

export const REGISTERABLE_ACTIONS = new Set<HotkeyAction>([
  'toggle-mic',
  'toggle-deafen',
  'toggle-camera',
  'toggle-screen-share',
  'return-to-voice',
  'disconnect-voice',
  'navigate-back',
  'navigate-forward',
  'push-to-talk',
  'push-to-mute',
])

export class HotkeyState {
  private readonly heldComboKeys = new Set<string>()
  private readonly heldActions = new Map<string, HotkeyAction>()
  private readonly heldComboKeyByTrigger = new Map<string, string>()

  handleInput(
    event: NativeInputEvent,
    bindings: HotkeyBinding[],
  ): HotkeyActivationEvent[] {
    if (event.type === 'keyUp' || event.type === 'mouseUp') {
      const triggerKey = triggerKeyFromNativeInputEvent(event)
      const key = this.heldComboKeyByTrigger.get(triggerKey)
      if (!key) return []

      const action = this.heldActions.get(key)
      this.heldComboKeys.delete(key)
      this.heldActions.delete(key)
      this.heldComboKeyByTrigger.delete(triggerKey)

      return action && isHoldAction(action)
        ? [{ action, phase: 'released' }]
        : []
    }

    const events: HotkeyActivationEvent[] = []
    for (const binding of bindings) {
      if (!binding.enabled || !binding.combo) continue
      if (!REGISTERABLE_ACTIONS.has(binding.action)) continue
      if (!comboMatchesNativeInput(binding.combo, event)) continue

      const key = comboKey(binding.combo)
      if (this.heldComboKeys.has(key)) continue

      this.heldComboKeys.add(key)
      this.heldActions.set(key, binding.action)
      this.heldComboKeyByTrigger.set(triggerKeyFromCombo(binding.combo), key)
      events.push({ action: binding.action, phase: 'pressed' })
    }

    return events
  }

  releaseHeldActions(): HotkeyActivationEvent[] {
    const events: HotkeyActivationEvent[] = []
    for (const action of this.heldActions.values()) {
      if (isHoldAction(action)) events.push({ action, phase: 'released' })
    }
    this.heldComboKeys.clear()
    this.heldActions.clear()
    this.heldComboKeyByTrigger.clear()
    return events
  }
}

export function comboKey(combo: HotkeyCombo) {
  return JSON.stringify(combo).toLowerCase()
}

function comboMatchesNativeInput(combo: HotkeyCombo, event: NativeInputEvent) {
  return comboKey(combo) === comboKey(comboFromNativeInputEvent(event))
}

function comboFromNativeInputEvent(event: NativeInputEvent): HotkeyCombo {
  if (event.type === 'mouseDown' || event.type === 'mouseUp') {
    return {
      trigger: { type: 'mouse', button: event.button },
      modifiers: { ...event.modifiers },
    }
  }

  if (event.type === 'keyDown' || event.type === 'keyUp') {
    const modifier = modifierFromCode(event.code)
    if (modifier) {
      return {
        trigger: { type: 'modifier', modifier },
        modifiers: { ...event.modifiers, [modifier]: false },
      }
    }

    return {
      trigger: { type: 'keyboard', code: event.code, key: event.key },
      modifiers: { ...event.modifiers },
    }
  }

  throw new Error(`Unsupported native input event: ${JSON.stringify(event)}`)
}

function triggerKeyFromNativeInputEvent(event: NativeInputEvent) {
  return triggerKeyFromCombo(comboFromNativeInputEvent(event))
}

function triggerKeyFromCombo(combo: HotkeyCombo) {
  return JSON.stringify(combo.trigger).toLowerCase()
}

function modifierFromCode(code: string): HotkeyModifier | null {
  if (code === 'ControlLeft' || code === 'ControlRight' || code === 'Control') return 'ctrl'
  if (code === 'AltLeft' || code === 'AltRight' || code === 'Alt') return 'alt'
  if (code === 'ShiftLeft' || code === 'ShiftRight' || code === 'Shift') return 'shift'
  if (code === 'MetaLeft' || code === 'MetaRight' || code === 'Meta') return 'meta'
  return null
}

function isHoldAction(action: HotkeyAction) {
  return action === 'push-to-talk' || action === 'push-to-mute'
}
