import { existsSync } from 'node:fs'
import path from 'node:path'

import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import {
  AudioEffectChainSchema,
  AudioEffectSlotUpdateSchema,
  IPC,
} from '@syrnike13/platform'
import { Schema } from 'effect'

import { decodeIpcInput } from '../ipc-schema'
import { resolveMediaUtilityPaths } from '../media-runtime/media-utility-adapter'
import { AudioEffectsService } from './audio-effects-service'

const SlotIdInputSchema = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/))

let service: AudioEffectsService | null = null
let busId: string | null = null
const busListeners = new Set<(busId: string | null) => void>()

/** The live effect bus for the microphone, independent of startup order. */
export function currentAudioEffectsBus(): string | null { return busId }
export function onAudioEffectsBusChange(listener: (busId: string | null) => void): () => void {
  busListeners.add(listener)
  return () => busListeners.delete(listener)
}

function pluginHostPath(): string | null {
  if (process.platform !== 'win32') return null
  const executable = path.join(path.dirname(resolveMediaUtilityPaths().nativeModulePath), 'syrnike_audio_plugin_host.exe')
  return existsSync(executable) ? executable : null
}

function windowHandle(window: BrowserWindow | null): string | null {
  if (!window || window.isDestroyed()) return null
  const handle = window.getNativeWindowHandle()
  return handle.length >= 8 ? handle.readBigUInt64LE(0).toString() : String(handle.readUInt32LE(0))
}

export function registerAudioEffectsIpc(getWindow: () => BrowserWindow | null) {
  if (process.platform !== 'win32' || service) return
  const send = (channel: string, payload: unknown) => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
  }
  const current = new AudioEffectsService({
    storageDir: app.getPath('userData'),
    executablePath: pluginHostPath,
    ownerWindowHandle: () => windowHandle(getWindow()),
    onState: state => send(IPC.audioEffectsStateChanged, state),
    onCatalog: catalog => send(IPC.audioPluginsCatalogChanged, catalog),
  })
  service = current
  current.onBusChange(next => {
    busId = next
    for (const listener of busListeners) listener(next)
  })
  void current.load().catch(error => console.error('[audio-effects] failed to load the effect chain', error))
  app.once('will-quit', () => { void current.dispose() })

  const trusted = (event: IpcMainInvokeEvent) => {
    const window = getWindow()
    if (!window || window.isDestroyed() || event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Untrusted audio effects IPC sender')
    }
  }
  ipcMain.handle(IPC.audioEffectsGetState, event => {
    trusted(event)
    return current.state()
  })
  ipcMain.handle(IPC.audioEffectsSetChain, (event, input: unknown) => {
    trusted(event)
    return current.setChain(decodeIpcInput(IPC.audioEffectsSetChain, 'slots', AudioEffectChainSchema, input))
  })
  ipcMain.handle(IPC.audioEffectsUpdateSlot, (event, input: unknown) => {
    trusted(event)
    current.updateSlot(decodeIpcInput(IPC.audioEffectsUpdateSlot, 'update', AudioEffectSlotUpdateSchema, input))
  })
  ipcMain.handle(IPC.audioEffectsOpenEditor, (event, input: unknown) => {
    trusted(event)
    return current.openEditor(decodeIpcInput(IPC.audioEffectsOpenEditor, 'slotId', SlotIdInputSchema, input))
  })
  ipcMain.handle(IPC.audioEffectsGetStats, event => {
    trusted(event)
    return current.stats()
  })
  ipcMain.handle(IPC.audioPluginsGetCatalog, event => {
    trusted(event)
    return current.getCatalog()
  })
  ipcMain.handle(IPC.audioPluginsScan, event => {
    trusted(event)
    return current.scanPlugins()
  })
}
