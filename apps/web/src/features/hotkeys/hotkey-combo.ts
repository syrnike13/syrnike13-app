import type {
  HotkeyAction,
  HotkeyBinding,
  HotkeyCombo,
  NativeInputEvent,
} from '@syrnike13/platform'

export type HotkeyActionDefinition = {
  id: HotkeyAction
  label: string
  description: string
  available: boolean
}

export const HOTKEY_ACTIONS: HotkeyActionDefinition[] = [
  {
    id: 'toggle-mic',
    label: 'Вкл./выкл. микрофон',
    description: 'Включает или выключает микрофон.',
    available: true,
  },
  {
    id: 'toggle-deafen',
    label: 'Вкл./выкл. звук',
    description: 'Отключает входящий звук и микрофон.',
    available: true,
  },
  {
    id: 'toggle-camera',
    label: 'Вкл./выкл. камеру',
    description: 'Включает или выключает камеру в голосовом канале.',
    available: true,
  },
  {
    id: 'toggle-screen-share',
    label: 'Вкл./выкл. демонстрацию экрана',
    description: 'Запускает или останавливает демонстрацию экрана.',
    available: true,
  },
  {
    id: 'return-to-voice',
    label: 'Вернуться к голосовому каналу',
    description: 'Открывает активный голосовой канал.',
    available: true,
  },
  {
    id: 'disconnect-voice',
    label: 'Отключиться от голосового канала',
    description: 'Выходит из текущего голосового канала.',
    available: true,
  },
  {
    id: 'navigate-back',
    label: 'Назад',
    description: 'Переходит назад по истории приложения.',
    available: true,
  },
  {
    id: 'navigate-forward',
    label: 'Вперёд',
    description: 'Переходит вперёд по истории приложения.',
    available: true,
  },
  {
    id: 'push-to-talk',
    label: 'Удерживать для разговора',
    description: 'Включает микрофон, пока клавиша удерживается.',
    available: true,
  },
  {
    id: 'push-to-mute',
    label: 'Удерживать для отключения микрофона',
    description: 'Отключает микрофон, пока клавиша удерживается.',
    available: true,
  },
  {
    id: 'priority-push-to-talk',
    label: 'Приоритетный Push-to-Talk',
    description: 'Скоро: требует приоритетной голосовой модели.',
    available: false,
  },
  {
    id: 'toggle-vad',
    label: 'Переключить Voice Activity / Push-to-Talk',
    description: 'Скоро: появится вместе с режимом Push-to-Talk.',
    available: false,
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
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const codes = normalizeCodes(
      events[index].type === 'inputDown'
        ? events[index].pressedCodes
        : [...events[index].pressedCodes, events[index].code],
    )
    if (codes.length > 0) return { codes }
  }

  return null
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

export function comboDisplayLabel(combo: HotkeyCombo | null) {
  if (!combo) return 'Не назначено'

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

function normalizeCodes(codes: string[]) {
  return Array.from(new Set(codes.filter((code) => code.length > 0))).sort()
}
