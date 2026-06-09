import { spawn, type ChildProcessByStdio } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import type { Readable } from 'node:stream'

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

const HOTKEYS_FILE = 'hotkeys-v2.json'

let bindings: HotkeyBinding[] = []
let registrationResults: HotkeyRegistrationResult[] = []
let suspended = false
let recording = false
let runtimeStatus: HotkeyRuntimeStatus = 'not-running'
let helper: ChildProcessByStdio<null, Readable, Readable> | null = null
let getWindowRef: (() => BrowserWindow | null) | null = null
const hotkeyState = new HotkeyState()

export function initializeHotkeys(getWindow: () => BrowserWindow | null) {
  getWindowRef = getWindow
  bindings = readHotkeyBindings()
  registrationResults = validateBindings(bindings)
  startNativeHelper()
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
  return runtimeStatus
}

export function disposeHotkeys() {
  emitHotkeyPressedEvents(hotkeyState.releaseHeldActions())
  helper?.kill()
  helper = null
  getWindowRef = null
  registrationResults = []
}

function startNativeHelper() {
  if (process.platform !== 'win32') {
    runtimeStatus = 'unsupported-platform'
    return
  }

  const helperPath = resolveHelperPath()
  if (!helperPath) {
    runtimeStatus = 'not-running'
    return
  }

  const nextHelper = spawn(helperPath, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  helper = nextHelper
  runtimeStatus = 'running'

  const lines = readline.createInterface({ input: nextHelper.stdout })
  lines.on('line', (line) => {
    const event = parseNativeInputEvent(line)
    if (event) handleNativeInputEvent(event)
  })

  nextHelper.stderr.resume()

  nextHelper.on('exit', () => {
    runtimeStatus = 'not-running'
    helper = null
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

function resolveHelperPath() {
  const helperName = 'syrnike-hotkey-helper-win.exe'
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'native', helperName)]
    : [
        path.resolve(app.getAppPath(), 'out/native', helperName),
        path.resolve(
          app.getAppPath(),
          'native/hotkey-helper-win/build/Release',
          helperName,
        ),
        path.resolve(
          app.getAppPath(),
          'native/hotkey-helper-win/build/Debug',
          helperName,
        ),
      ]

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null
}

function parseNativeInputEvent(line: string): NativeInputEvent | null {
  try {
    const parsed = JSON.parse(line) as NativeInputEvent
    if (
      (parsed.type === 'inputDown' || parsed.type === 'inputUp') &&
      (parsed.source === 'keyboard' || parsed.source === 'mouse') &&
      typeof parsed.code === 'string' &&
      typeof parsed.label === 'string' &&
      Array.isArray(parsed.pressedCodes) &&
      parsed.pressedCodes.every((code) => typeof code === 'string')
    ) {
      return {
        type: parsed.type,
        source: parsed.source,
        code: parsed.code,
        label: parsed.label,
        pressedCodes: normalizeCodes(parsed.pressedCodes),
      }
    }
  } catch {
    return null
  }
  return null
}

function normalizeCodes(codes: string[]) {
  return Array.from(new Set(codes.filter((code) => code.length > 0))).sort()
}
