import fs from 'node:fs'
import path from 'node:path'

import { app, type BrowserWindow, type WebContents } from 'electron'
import {
  IPC,
  HotkeyActionSchema,
  HotkeyBindingSchema,
  type HotkeyAction,
  type HotkeyActivationEvent,
  type HotkeyBinding,
  type HotkeyCombo,
  type HotkeyRegistrationResult,
  type HotkeyRuntimeStatus,
  type NativeInputEvent,
} from '@syrnike13/platform'
import { Effect, Option, Schema } from 'effect'

import { HotkeyState, REGISTERABLE_ACTIONS, comboKey } from './hotkey-state'
import { hooksRuntimeController } from './native-runtime/hooks-runtime-controller'

const HOTKEYS_FILE = 'hotkeys-v2.json'
const UnknownArraySchema = Schema.Array(Schema.Unknown)
const PersistedHotkeyBindingSchema = Schema.Struct({
  id: Schema.String,
  action: HotkeyActionSchema,
  enabled: Schema.Boolean,
  combo: Schema.optionalKey(Schema.Unknown),
})
const PersistedHotkeyBindingsJsonSchema = Schema.fromJsonString(
  Schema.Array(PersistedHotkeyBindingSchema),
)
const HotkeyBindingsJsonSchema = Schema.fromJsonString(
  Schema.Array(HotkeyBindingSchema),
)

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

  Effect.runFork(
    hooksRuntimeController.startHotkeysEffect(handleNativeInputEvent).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          console.warn(
            '[hotkeys] native runtime failed to start',
            error instanceof Error ? error.message : 'unknown error',
          )
          emitHotkeyPressedEvents(hotkeyState.releaseHeldActions())
        }),
      ),
    ),
  )
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
  const items = Schema.decodeUnknownOption(UnknownArraySchema)(value)
  if (Option.isNone(items)) return []

  return items.value.flatMap((item) => {
    const decoded = Schema.decodeUnknownOption(PersistedHotkeyBindingSchema)(item)
    if (Option.isNone(decoded)) return []
    const binding = decoded.value
    if (!REGISTERABLE_ACTIONS.has(binding.action)) return []

    return [
      {
        id: binding.id,
        action: binding.action,
        combo: sanitizeCombo(binding.combo),
        enabled: binding.enabled,
      },
    ]
  })
}

function sanitizeCombo(value: unknown): HotkeyCombo | null {
  const combo = Schema.decodeUnknownOption(
    Schema.Struct({ codes: Schema.Array(Schema.String) }),
  )(value)
  if (Option.isNone(combo)) return null

  const codes = normalizeCodes(combo.value.codes)
  return codes.length > 0 ? { codes } : null
}

function readHotkeyBindings() {
  try {
    const raw = fs.readFileSync(resolveHotkeysPath(), 'utf8')
    return Option.match(
      Schema.decodeUnknownOption(PersistedHotkeyBindingsJsonSchema)(raw),
      {
      onNone: () => [],
      onSome: sanitizeHotkeyBindings,
      },
    )
  } catch {
    return []
  }
}

function writeHotkeyBindings(nextBindings: HotkeyBinding[]) {
  const filePath = resolveHotkeysPath()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(
    filePath,
    `${Schema.encodeSync(HotkeyBindingsJsonSchema)(nextBindings)}\n`,
  )
}

function resolveHotkeysPath() {
  return path.join(app.getPath('userData'), HOTKEYS_FILE)
}

function normalizeCodes(codes: ReadonlyArray<string>) {
  return Array.from(new Set(codes.filter((code) => code.length > 0))).sort()
}
