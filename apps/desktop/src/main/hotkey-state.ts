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
    const events = this.releaseMissingCombos(pressedCodes)

    if (event.type !== 'inputDown') return events

    for (const binding of bindings) {
      if (!binding.enabled || !binding.combo) continue
      if (!REGISTERABLE_ACTIONS.has(binding.action)) continue
      if (!comboMatchesPressedCodes(binding.combo, pressedCodes)) continue

      const key = comboKey(binding.combo)
      if (this.activeCombos.has(key)) continue

      this.activeCombos.set(key, {
        action: binding.action,
        codes: normalizeCodes(binding.combo.codes),
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
  return JSON.stringify({ codes: normalizeCodes(combo.codes) }).toLowerCase()
}

function comboMatchesPressedCodes(combo: HotkeyCombo, pressedCodes: string[]) {
  return comboKey(combo) === JSON.stringify({ codes: pressedCodes }).toLowerCase()
}

function normalizeCodes(codes: string[]) {
  return Array.from(new Set(codes.filter((code) => code.length > 0))).sort()
}

function isHoldAction(action: HotkeyAction) {
  return action === 'push-to-talk' || action === 'push-to-mute'
}
