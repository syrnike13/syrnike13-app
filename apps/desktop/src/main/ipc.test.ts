import { describe, expect, it, vi } from 'vitest'

const handleMock = vi.hoisted(() => vi.fn())
const onMock = vi.hoisted(() => vi.fn())
const clipboardWriteTextMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0',
  },
  clipboard: {
    writeText: clipboardWriteTextMock,
  },
  ipcMain: {
    handle: handleMock,
    on: onMock,
  },
}))

vi.mock('./auto-update', () => ({
  checkForDesktopUpdates: vi.fn(),
  getDesktopUpdateState: vi.fn(() => ({ status: 'idle' })),
  quitAndInstallDesktopUpdate: vi.fn(),
}))

vi.mock('./hotkeys', () => ({
  getHotkeyBindings: vi.fn(() => []),
  getHotkeyRuntimeStatus: vi.fn(() => 'not-running'),
  initializeHotkeys: vi.fn(),
  setHotkeyBindings: vi.fn(() => []),
  setHotkeysSuspended: vi.fn(),
  startHotkeyRecording: vi.fn(),
  stopHotkeyRecording: vi.fn(),
}))

vi.mock('./desktop-session', () => ({
  clearDesktopSession: vi.fn(),
  loadDesktopSession: vi.fn(() => null),
  saveDesktopSession: vi.fn(),
}))

vi.mock('./desktop-local-settings', () => ({
  desktopLocalSettingsDefaults: vi.fn(() => ({})),
  loadDesktopLocalSettings: vi.fn(() => ({})),
  updateDesktopLocalSettings: vi.fn(() => ({})),
}))

vi.mock('./native-media-engine', () => ({
  registerNativeMediaEngineIpc: vi.fn(),
}))

vi.mock('./media-permissions', () => ({
  registerDisplayMediaIpc: vi.fn(),
}))

vi.mock('./overlay-manager', () => ({
  canSetDesktopOverlaySnapshot: vi.fn(() => true),
  canUseDesktopOverlaySender: vi.fn(() => true),
  getDesktopOverlayState: vi.fn(() => ({
    available: false,
    enabled: false,
    visible: false,
    target: null,
    snapshot: { active: false, channelId: null, channelLabel: null, participants: [] },
  })),
  setDesktopOverlayEnabled: vi.fn(),
  setDesktopOverlaySettings: vi.fn(),
  setDesktopOverlaySnapshot: vi.fn(),
}))

describe('registerDesktopIpc', () => {
  it('writes copied text through the native Electron clipboard', async () => {
    const { IPC } = await import('@syrnike13/platform')
    const { registerDesktopIpc } = await import('./ipc')

    registerDesktopIpc(() => null, {
      getWindowPreferences: () => ({ closeToTray: false, openAtLogin: false }),
      setCloseToTray: vi.fn(),
      setOpenAtLogin: vi.fn(),
      setTrayVoiceState: vi.fn(),
      showWindow: vi.fn(),
      localSettingsPath: 'local-settings.json',
      sessionPath: 'session.json',
    })

    const registration = handleMock.mock.calls.find(
      ([channel]) => channel === IPC.clipboardWriteText,
    )

    expect(registration).toBeDefined()
    await registration?.[1]({}, 'message-id-1')
    expect(clipboardWriteTextMock).toHaveBeenCalledWith('message-id-1')
  })
})
