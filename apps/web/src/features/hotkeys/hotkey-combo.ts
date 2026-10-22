import type {
  HotkeyAction,
  HotkeyBinding,
  HotkeyCombo,
  NativeInputEvent,
} from '@syrnike13/platform'
import type { Translator } from '@syrnike13/ui/i18n'

export type HotkeyActionDefinition = {
  id: HotkeyAction
  available: boolean
}

export const HOTKEY_ACTIONS: HotkeyActionDefinition[] = [
  {
    id: 'toggle-mic',
    available: true,
  },
  {
    id: 'toggle-deafen',
    available: true,
  },
  {
    id: 'toggle-camera',
    available: true,
  },
  {
    id: 'toggle-screen-share',
    available: true,
  },
  {
    id: 'return-to-voice',
    available: true,
  },
  {
    id: 'disconnect-voice',
    available: true,
  },
  {
    id: 'navigate-back',
    available: true,
  },
  {
    id: 'navigate-forward',
    available: true,
  },
  {
    id: 'push-to-talk',
    available: true,
  },
  {
    id: 'push-to-mute',
    available: true,
  },
  {
    id: 'priority-push-to-talk',
    available: false,
  },
  {
    id: 'toggle-vad',
    available: true,
  },
]

const CODE_LABELS: Record<string, string> = {
  ControlLeft: 'Left Ctrl',
  ControlRight: 'Right Ctrl',
  AltLeft: 'Left Alt',
  AltRight: 'Right Alt',
  ShiftLeft: 'Left Shift',
  ShiftRight: 'Right Shift',
  MetaLeft: 'Left Meta',
  MetaRight: 'Right Meta',
  Escape: 'Esc',
  Space: 'Space',
  Mouse3: 'Mouse3',
  Mouse4: 'Mouse4',
  Mouse5: 'Mouse5',
}

export function canRegisterHotkeyAction(action: HotkeyAction) {
  return HOTKEY_ACTIONS.some((item) => item.id === action && item.available)
}

export function getHotkeyAction(action: HotkeyAction) {
  return HOTKEY_ACTIONS.find((item) => item.id === action) ?? HOTKEY_ACTIONS[0]
}

export function comboFromNativeInputEvent(
  event: NativeInputEvent,
): HotkeyCombo {
  return { codes: normalizeCodes(event.pressedCodes) }
}

export function comboFromRecordedInputs(
  events: NativeInputEvent[],
): HotkeyCombo | null {
  const pressedCodes = new Set<string>()
  let lastComboCodes: string[] | null = null

  for (const event of events) {
    if (event.type === 'inputDown') {
      pressedCodes.add(event.code)
      lastComboCodes = normalizeCodes([...pressedCodes])
      continue
    }

    if (!pressedCodes.has(event.code)) continue

    lastComboCodes = normalizeCodes([...pressedCodes])
    pressedCodes.delete(event.code)
  }

  return lastComboCodes ? { codes: lastComboCodes } : null
}

export function hotkeyMatchesNativeInput(
  combo: HotkeyCombo,
  event: NativeInputEvent,
) {
  const eventCombo = comboFromNativeInputEvent(event)
  return comboKey(combo) === comboKey(eventCombo)
}

export function shouldCaptureRecordedInput(event: NativeInputEvent) {
  return event.type === 'inputUp'
}

export function comboDisplayLabel(combo: HotkeyCombo | null, t: Translator) {
  if (!combo) return t('unassigned')

  return normalizeCodes(combo.codes).map(labelForCode).join('+')
}

export function comboKey(combo: HotkeyCombo | null) {
  if (!combo) return ''
  return JSON.stringify({ codes: normalizeCodes(combo.codes) }).toLowerCase()
}

export function findDuplicateCombos(bindings: HotkeyBinding[]) {
  const comboToIds = new Map<string, string[]>()

  for (const binding of bindings) {
    if (!binding.enabled || !binding.combo) continue
    const key = comboKey(binding.combo)
    comboToIds.set(key, [...(comboToIds.get(key) ?? []), binding.id])
  }

  const duplicateIds = new Set<string>()
  for (const ids of comboToIds.values()) {
    if (ids.length < 2) continue
    ids.forEach((id) => duplicateIds.add(id))
  }

  return duplicateIds
}

function labelForCode(code: string) {
  if (CODE_LABELS[code]) return CODE_LABELS[code]
  if (code.startsWith('Key')) return code.slice(3).toUpperCase()
  if (code.startsWith('Digit')) return code.slice(5)
  return code
}

function normalizeCodes(codes: ReadonlyArray<string>) {
  return Array.from(new Set(codes.filter((code) => code.length > 0))).sort()
}
