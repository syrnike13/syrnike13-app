import fs from 'node:fs'
import path from 'node:path'

import { app, type BrowserWindow, type WebContents } from 'electron'
import {
  IPC,
  type HotkeyAction,
  type HotkeyActivationEvent,
  type HotkeyBinding,
  type HotkeyCombo,
  type HotkeyRegistrationResult,
  type HotkeyRuntimeStatus,
  type NativeInputEvent,
} from '@syrnike13/platform'

import { HotkeyState, REGISTERABLE_ACTIONS, comboKey } from './hotkey-state'
import { hooksRuntimeController } from './native-runtime/hooks-runtime-controller'

const HOTKEYS_FILE = 'hotkeys-v2.json'

let bindings: HotkeyBinding[] = []
let registrationResults: HotkeyRegistrationResult[] = []
let suspended = false
let recording = false
let getWindowRef: (() => BrowserWindow | null) | null = null
let unsubscribeRuntimeState: (() => void) | null = null
const hotkeyState = new HotkeyState()
const activationListeners = new Set<(event: HotkeyActivationEvent) => void>()

export function subscribeHotkeyActivations(
  listener: (event: HotkeyActivationEvent) => void,
) {
  activationListeners.add(listener)
  return () => activationListeners.delete(listener)
}

export function initializeHotkeys(getWindow: () => BrowserWindow | null) {
  getWindowRef = getWindow
  bindings = readHotkeyBindings()
  registrationResults = validateBindings(bindings)
  unsubscribeRuntimeState?.()
  unsubscribeRuntimeState = hooksRuntimeController.onStateChange((snapshot) => {
    if (
      snapshot.status === 'recovering' ||
      snapshot.status === 'degraded' ||
      snapshot.status === 'stopped'
    ) {
      emitHotkeyPressedEvents(hotkeyState.releaseHeldActions())
    }
  })
  startNativeRuntime()
}

export function getHotkeyBindings() {
  return [...bindings]
}

export function setHotkeyBindings(nextBindings: HotkeyBinding[]) {
  bindings = sanitizeHotkeyBindings(nextBindings)
  writeHotkeyBindings(bindings)
  registrationResults = validateBindings(bindings)
  return [...registrationResults]
}

export function setHotkeysSuspended(nextSuspended: boolean) {
  if (nextSuspended) emitHotkeyPressedEvents(hotkeyState.releaseHeldActions())
  suspended = nextSuspended
}

export function startHotkeyRecording() {
  recording = true
}

export function stopHotkeyRecording() {
  recording = false
}

export function getHotkeyRuntimeStatus() {
  if (process.platform !== 'win32') return 'unsupported-platform'
  if (!hooksRuntimeController.isAvailable('hotkey')) return 'not-running'
  return hooksRuntimeController.getStatus('hotkey') === 'ready'
    ? 'running'
    : 'not-running'
}

export function disposeHotkeys() {
  emitHotkeyPressedEvents(hotkeyState.releaseHeldActions())
  void hooksRuntimeController.stopHotkeys(handleNativeInputEvent)
  unsubscribeRuntimeState?.()
  unsubscribeRuntimeState = null
  getWindowRef = null
  registrationResults = []
}

function startNativeRuntime() {
  if (process.platform !== 'win32') {
    return
  }

  void hooksRuntimeController.startHotkeys(handleNativeInputEvent).catch((error) => {
    console.warn(
      '[hotkeys] native runtime failed to start',
      error instanceof Error ? error.message : 'unknown error',
    )
    emitHotkeyPressedEvents(hotkeyState.releaseHeldActions())
  })
}

function handleNativeInputEvent(event: NativeInputEvent) {
  if (recording) emitRecordedInput(event)
  if (suspended) return

  emitHotkeyPressedEvents(hotkeyState.handleInput(event, bindings))
}

function emitHotkeyPressedEvents(events: HotkeyActivationEvent[]) {
  for (const event of events) emitHotkeyPressed(event)
}

function validateBindings(nextBindings: HotkeyBinding[]) {
  const seen = new Set<string>()
  return nextBindings.map((binding) => {
    if (!binding.enabled) return { id: binding.id, status: 'disabled' as const }
    if (!binding.combo) return { id: binding.id, status: 'invalid' as const }
    if (!REGISTERABLE_ACTIONS.has(binding.action)) {
      return { id: binding.id, status: 'unsupported' as const }
    }
    const key = comboKey(binding.combo)
    if (seen.has(key)) return { id: binding.id, status: 'taken' as const }
    seen.add(key)
    return { id: binding.id, status: 'registered' as const }
  })
}

function emitHotkeyPressed(event: HotkeyActivationEvent) {
  for (const listener of activationListeners) listener(event)
  const webContents = getWindowRef?.()?.webContents
  if (!canSendToRenderer(webContents)) return
  webContents.send(IPC.hotkeysPressed, event)
}

function emitRecordedInput(event: NativeInputEvent) {
  const webContents = getWindowRef?.()?.webContents
  if (!canSendToRenderer(webContents)) return
  webContents.send(IPC.hotkeysRecordedInput, event)
}

function canSendToRenderer(
  webContents: WebContents | undefined,
): webContents is WebContents {
  return Boolean(webContents && !webContents.isDestroyed())
}

export function sanitizeHotkeyBindings(value: unknown): HotkeyBinding[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const binding = item as Partial<HotkeyBinding>
    if (
      typeof binding.id !== 'string' ||
      typeof binding.action !== 'string' ||
      typeof binding.enabled !== 'boolean' ||
      !REGISTERABLE_ACTIONS.has(binding.action as HotkeyAction)
    ) {
      return []
    }

    return [
      {
        id: binding.id,
        action: binding.action as HotkeyAction,
        combo: sanitizeCombo(binding.combo),
        enabled: binding.enabled,
      },
    ]
  })
}

function sanitizeCombo(value: unknown): HotkeyCombo | null {
  if (!value || typeof value !== 'object') return null
  const combo = value as { codes?: unknown }
  const rawCodes = combo.codes
  if (!Array.isArray(rawCodes)) return null
  if (!rawCodes.every((code): code is string => typeof code === 'string')) {
    return null
  }

  const codes = normalizeCodes(rawCodes)
  return codes.length > 0 ? { codes } : null
}

function readHotkeyBindings() {
  try {
    const raw = fs.readFileSync(resolveHotkeysPath(), 'utf8')
    return sanitizeHotkeyBindings(JSON.parse(raw))
  } catch {
    return []
  }
}

function writeHotkeyBindings(nextBindings: HotkeyBinding[]) {
  const filePath = resolveHotkeysPath()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(nextBindings, null, 2)}\n`)
}

function resolveHotkeysPath() {
  return path.join(app.getPath('userData'), HOTKEYS_FILE)
}

function normalizeCodes(codes: string[]) {
  return Array.from(new Set(codes.filter((code) => code.length > 0))).sort()
}
