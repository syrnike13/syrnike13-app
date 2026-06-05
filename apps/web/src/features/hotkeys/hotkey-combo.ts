import type {
  HotkeyAction,
  HotkeyBinding,
  HotkeyCombo,
  HotkeyModifier,
  HotkeyModifiers,
  NativeInputEvent,
} from '@syrnike13/platform'

export type HotkeyActionDefinition = {
  id: HotkeyAction
  label: string
  description: string
  available: boolean
}

export const EMPTY_MODIFIERS: HotkeyModifiers = {
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
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

const MODIFIER_LABELS: Record<HotkeyModifier, string> = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  meta: 'Meta',
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
  if (event.type === 'mouseDown' || event.type === 'mouseUp') {
    return {
      trigger: { type: 'mouse', button: event.button },
      modifiers: { ...event.modifiers },
    }
  }

  const modifier = modifierFromCode(event.code)
  if (modifier) {
    const modifiers = { ...event.modifiers, [modifier]: false }
    return {
      trigger: { type: 'modifier', modifier },
      modifiers,
    }
  }

  return {
    trigger: { type: 'keyboard', code: event.code, key: event.key },
    modifiers: { ...event.modifiers },
  }
}

export function hotkeyMatchesNativeInput(
  combo: HotkeyCombo,
  event: NativeInputEvent,
) {
  const eventCombo = comboFromNativeInputEvent(event)
  return comboKey(combo) === comboKey(eventCombo)
}

export function shouldCaptureRecordedInput(event: NativeInputEvent) {
  if (event.type === 'mouseDown') return true
  if (event.type === 'mouseUp') return false
  const modifier = modifierFromCode(event.code)
  if (!modifier) return event.type === 'keyDown'
  return event.type === 'keyUp'
}

export function comboDisplayLabel(combo: HotkeyCombo | null) {
  if (!combo) return 'Не назначено'

  const parts: string[] = []
  for (const modifier of ['ctrl', 'alt', 'shift', 'meta'] as const) {
    if (combo.modifiers[modifier]) parts.push(MODIFIER_LABELS[modifier])
  }

  if (combo.trigger.type === 'keyboard') {
    parts.push(normalizeKeyLabel(combo.trigger.key, combo.trigger.code))
  } else if (combo.trigger.type === 'mouse') {
    parts.push(combo.trigger.button)
  } else {
    parts.push(MODIFIER_LABELS[combo.trigger.modifier])
  }

  return parts.join('+')
}

export function comboKey(combo: HotkeyCombo | null) {
  if (!combo) return ''
  return JSON.stringify({
    trigger: combo.trigger,
    modifiers: combo.modifiers,
  }).toLowerCase()
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

function normalizeKeyLabel(key: string, code: string) {
  if (key.length === 1) return key.toUpperCase()
  if (code.startsWith('Key')) return code.slice(3).toUpperCase()
  if (code.startsWith('Digit')) return code.slice(5)
  return key || code
}

function modifierFromCode(code: string): HotkeyModifier | null {
  if (code === 'ControlLeft' || code === 'ControlRight' || code === 'Control') return 'ctrl'
  if (code === 'AltLeft' || code === 'AltRight' || code === 'Alt') return 'alt'
  if (code === 'ShiftLeft' || code === 'ShiftRight' || code === 'Shift') return 'shift'
  if (code === 'MetaLeft' || code === 'MetaRight' || code === 'Meta') return 'meta'
  return null
}
