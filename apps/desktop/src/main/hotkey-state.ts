import type {
  HotkeyAction,
  HotkeyActivationEvent,
  HotkeyBinding,
  HotkeyCombo,
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

type ActiveCombo = {
  action: HotkeyAction
  codes: string[]
}

export class HotkeyState {
  private readonly activeCombos = new Map<string, ActiveCombo>()

  handleInput(
    event: NativeInputEvent,
    bindings: HotkeyBinding[],
  ): HotkeyActivationEvent[] {
    const pressedCodes = normalizeCodes(event.pressedCodes)
    const pressedCodeSet = new Set(pressedCodes)
    const events = this.releaseMissingCombos(pressedCodes)

    if (event.type !== 'inputDown') return events

    const matchingBindings: Array<{
      binding: HotkeyBinding
      bindingCodes: string[]
    }> = []

    for (const binding of bindings) {
      if (!binding.enabled || !binding.combo) continue
      if (!REGISTERABLE_ACTIONS.has(binding.action)) continue

      const bindingCodes = normalizeCodes(binding.combo.codes)
      if (!comboCodesArePressed(bindingCodes, pressedCodeSet)) continue

      matchingBindings.push({ binding, bindingCodes })
    }

    const mostSpecificCodeCount = matchingBindings.reduce(
      (count, match) => Math.max(count, match.bindingCodes.length),
      0,
    )

    for (const { binding, bindingCodes } of matchingBindings) {
      if (bindingCodes.length !== mostSpecificCodeCount) continue

      const key = comboKeyFromCodes(bindingCodes)
      if (this.activeCombos.has(key)) continue

      this.activeCombos.set(key, {
        action: binding.action,
        codes: bindingCodes,
      })
      events.push({ action: binding.action, phase: 'pressed' })
    }

    return events
  }

  releaseHeldActions(): HotkeyActivationEvent[] {
    const events: HotkeyActivationEvent[] = []
    for (const combo of this.activeCombos.values()) {
      if (isHoldAction(combo.action)) {
        events.push({ action: combo.action, phase: 'released' })
      }
    }
    this.activeCombos.clear()
    return events
  }

  private releaseMissingCombos(pressedCodes: string[]) {
    const pressed = new Set(pressedCodes)
    const events: HotkeyActivationEvent[] = []

    for (const [key, combo] of this.activeCombos) {
      if (combo.codes.every((code) => pressed.has(code))) continue

      this.activeCombos.delete(key)
      if (isHoldAction(combo.action)) {
        events.push({ action: combo.action, phase: 'released' })
      }
    }

    return events
  }
}

export function comboKey(combo: HotkeyCombo) {
  return comboKeyFromCodes(normalizeCodes(combo.codes))
}

function comboKeyFromCodes(codes: string[]) {
  return JSON.stringify({ codes }).toLowerCase()
}

function comboCodesArePressed(comboCodes: string[], pressedCodeSet: Set<string>) {
  if (comboCodes.length === 0) return false
  return comboCodes.every((code) => pressedCodeSet.has(code))
}

function normalizeCodes(codes: string[]) {
  return Array.from(new Set(codes.filter((code) => code.length > 0))).sort()
}

function isHoldAction(action: HotkeyAction) {
  return action === 'push-to-talk' || action === 'push-to-mute'
}
