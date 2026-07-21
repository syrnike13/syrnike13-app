import { beforeEach, describe, expect, it, vi } from 'vitest'

const handleMock = vi.hoisted(() => vi.fn())
const onMock = vi.hoisted(() => vi.fn())
const clipboardWriteTextMock = vi.hoisted(() => vi.fn())
const updateDesktopLocalSettingsMock = vi.hoisted(() => vi.fn(() => ({})))
const clearDesktopSessionMock = vi.hoisted(() => vi.fn(async () => undefined))
const loadDesktopSessionMock = vi.hoisted(() => vi.fn(async () => null))
const saveDesktopSessionMock = vi.hoisted(() => vi.fn(async () => undefined))

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
  clearDesktopSession: clearDesktopSessionMock,
  loadDesktopSession: loadDesktopSessionMock,
  saveDesktopSession: saveDesktopSessionMock,
}))

vi.mock('./desktop-local-settings', () => ({
  desktopLocalSettingsDefaults: vi.fn(() => ({})),
  loadDesktopLocalSettings: vi.fn(() => ({})),
  updateDesktopLocalSettings: updateDesktopLocalSettingsMock,
}))

vi.mock('./native-media-engine', () => ({
  createNativeRtcEngineAdapter: vi.fn(() => ({
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    updateDesiredMedia: vi.fn(),
    retryMedia: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    prewarmMicrophone: vi.fn(async () => undefined),
    dispose: vi.fn(),
  })),
  flushNativeMediaDiagnostics: vi.fn(async () => undefined),
  logNativeVoiceDiagnostic: vi.fn(),
  registerNativeMediaRuntimeIpc: vi.fn(),
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
  beforeEach(() => {
    handleMock.mockClear()
    onMock.mockClear()
    updateDesktopLocalSettingsMock.mockClear()
    clearDesktopSessionMock.mockReset().mockResolvedValue(undefined)
    loadDesktopSessionMock.mockReset().mockResolvedValue(null)
    saveDesktopSessionMock.mockReset().mockResolvedValue(undefined)
  })

  it('writes copied text through the native Electron clipboard', async () => {
    const { IPC } = await import('@syrnike13/platform')
    const { registerDesktopIpc } = await import('./ipc')

    registerDesktopIpc(() => null, {
      getWindowPreferences: () => ({ closeToTray: false, openAtLogin: false }),
      setCloseToTray: vi.fn(),
      setOpenAtLogin: vi.fn(),
      setTrayVoiceState: vi.fn(),
      updateLocalSettings: vi.fn(async () => ({} as never)),
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

  it('persists observability preferences through the typed settings seam', async () => {
    const { IPC } = await import('@syrnike13/platform')
    const { registerDesktopIpc } = await import('./ipc')
    const saved = {
      observability: {
        anonymousNativeMetrics: false,
        nativeCrashReports: true,
      },
    }
    const updateLocalSettings = vi.fn(async () => saved as never)

    registerDesktopIpc(() => null, {
      getWindowPreferences: () => ({ closeToTray: false, openAtLogin: false }),
      setCloseToTray: vi.fn(),
      setOpenAtLogin: vi.fn(),
      setTrayVoiceState: vi.fn(),
      updateLocalSettings,
      showWindow: vi.fn(),
      localSettingsPath: 'local-settings.json',
      sessionPath: 'session.json',
    })

    const registration = handleMock.mock.calls.find(
      ([channel]) => channel === IPC.settingsUpdate,
    )
    const patch = {
      observability: {
        anonymousNativeMetrics: false,
        nativeCrashReports: true,
      },
    }
    await expect(registration?.[1]({}, patch)).resolves.toBe(saved)
    expect(updateLocalSettings).toHaveBeenCalledWith(patch)
  })

  it('enqueues validated renderer incidents in the electron-main lease owner', async () => {
    const { IPC } = await import('@syrnike13/platform')
    const incidents = await import('./native-runtime/diagnostic-incidents')
    const { registerDesktopIpc } = await import('./ipc')
    incidents.clearNativeDiagnosticIncidentsForTests()
    incidents.configureNativeDiagnosticIncidentAccount('account-a')

    registerDesktopIpc(() => null, {
      getWindowPreferences: () => ({ closeToTray: false, openAtLogin: false }),
      setCloseToTray: vi.fn(),
      setOpenAtLogin: vi.fn(),
      setTrayVoiceState: vi.fn(),
      updateLocalSettings: vi.fn(async () => ({} as never)),
      showWindow: vi.fn(),
      localSettingsPath: 'local-settings.json',
      sessionPath: 'session.json',
    })

    const registration = handleMock.mock.calls.find(
      ([channel]) => channel === IPC.diagnosticsEnqueueIncident,
    )
    expect(registration?.[1]({}, 'account-a', {
      area: 'voice',
      severity: 'error',
      triggerCode: 'runtime_lost',
    })).toBe(true)
    expect(registration?.[1]({}, 'account-a', {
      area: 'voice',
      severity: 'invalid',
      triggerCode: 'runtime_lost',
    })).toBe(false)
    expect(incidents.leaseNativeDiagnosticIncidents('account-a')?.incidents).toEqual([
      expect.objectContaining({ identity: 'renderer:voice:runtime_lost' }),
    ])
  })

  it('scopes diagnostic ownership to account identity across auth IPC transitions', async () => {
    const { IPC } = await import('@syrnike13/platform')
    const incidents = await import('./native-runtime/diagnostic-incidents')
    const { registerDesktopIpc } = await import('./ipc')
    incidents.clearNativeDiagnosticIncidentsForTests()

    registerDesktopIpc(() => null, {
      getWindowPreferences: () => ({ closeToTray: false, openAtLogin: false }),
      setCloseToTray: vi.fn(),
      setOpenAtLogin: vi.fn(),
      setTrayVoiceState: vi.fn(),
      updateLocalSettings: vi.fn(async () => ({} as never)),
      showWindow: vi.fn(),
      localSettingsPath: 'local-settings.json',
      sessionPath: 'session.json',
    })

    const handler = (channel: string) => handleMock.mock.calls.find(
      ([registeredChannel]) => registeredChannel === channel,
    )?.[1]
    const saveSession = handler(IPC.authSaveSession)
    const clearSession = handler(IPC.authClearSession)
    const enqueue = handler(IPC.diagnosticsEnqueueIncident)
    const lease = handler(IPC.diagnosticsLeaseNativeIncidents)
    const acknowledge = handler(IPC.diagnosticsAcknowledgeNativeIncidents)
    const release = handler(IPC.diagnosticsReleaseNativeIncidents)

    await saveSession?.({}, {
      _id: 'session-a-1',
      user_id: 'account-a',
      token: 'token-a-1',
    })
    expect(enqueue?.({}, 'account-a', {
      area: 'voice',
      severity: 'error',
      triggerCode: 'runtime_lost',
    })).toBe(true)

    await saveSession?.({}, {
      _id: 'session-a-2',
      user_id: 'account-a',
      token: 'token-a-2',
    })
    const accountABatch = lease?.({}, 'account-a')
    expect(accountABatch).toMatchObject({ accountId: 'account-a' })
    expect(accountABatch?.incidents).toHaveLength(1)

    await saveSession?.({}, {
      _id: 'session-b',
      user_id: 'account-b',
      token: 'token-b',
    })
    expect(acknowledge?.({}, 'account-a', accountABatch!.id)).toBe(false)
    expect(release?.({}, 'account-a', accountABatch!.id)).toBe(false)
    expect(lease?.({}, 'account-a')).toBeNull()

    expect(enqueue?.({}, 'account-a', rendererIncident())).toBe(false)

    expect(enqueue?.({}, 'account-b', {
      area: 'voice',
      severity: 'error',
      triggerCode: 'runtime_lost',
    })).toBe(true)
    const accountBBatch = lease?.({}, 'account-b')
    expect(accountBBatch).toMatchObject({ accountId: 'account-b' })
    expect(acknowledge?.({}, 'account-a', accountBBatch!.id)).toBe(false)
    expect(release?.({}, 'account-a', accountBBatch!.id)).toBe(false)
    expect(release?.({}, 'account-b', accountBBatch!.id)).toBe(true)
    await clearSession?.({})
    expect(lease?.({}, 'account-b')).toBeNull()
    expect(enqueue?.({}, 'account-b', {
      area: 'voice',
      severity: 'error',
      triggerCode: 'runtime_lost',
    })).toBe(false)
  })

  it('serializes a late save before the newer clear intent reaches disk', async () => {
    const { IPC } = await import('@syrnike13/platform')
    const incidents = await import('./native-runtime/diagnostic-incidents')
    const { registerDesktopIpc } = await import('./ipc')
    incidents.clearNativeDiagnosticIncidentsForTests()
    const saveGate = deferred<void>()
    const diskOrder: string[] = []
    saveDesktopSessionMock.mockImplementationOnce(async () => {
      diskOrder.push('save:start')
      await saveGate.promise
      diskOrder.push('save:end')
    })
    clearDesktopSessionMock.mockImplementationOnce(async () => {
      diskOrder.push('clear')
    })

    registerDesktopIpc(() => null, ipcOptions())
    const handler = (channel: string) => handleMock.mock.calls.find(
      ([registeredChannel]) => registeredChannel === channel,
    )?.[1]
    const save = handler(IPC.authSaveSession)
    const clear = handler(IPC.authClearSession)
    const enqueue = handler(IPC.diagnosticsEnqueueIncident)
    const saving = save?.({}, storedSession('account-a', 'token-a'))
    await vi.waitFor(() => expect(saveDesktopSessionMock).toHaveBeenCalledTimes(1))

    const clearing = clear?.({})
    expect(clearDesktopSessionMock).not.toHaveBeenCalled()
    saveGate.resolve()
    await Promise.all([saving, clearing])

    expect(diskOrder).toEqual(['save:start', 'save:end', 'clear'])
    expect(enqueue?.({}, 'account-a', rendererIncident())).toBe(false)
  })

  it('does not return a loaded session after a newer logout intent', async () => {
    const { IPC } = await import('@syrnike13/platform')
    const { registerDesktopIpc } = await import('./ipc')
    const loadGate = deferred<ReturnType<typeof storedSession>>()
    loadDesktopSessionMock
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(() => loadGate.promise)

    registerDesktopIpc(() => null, ipcOptions())
    await vi.waitFor(() => expect(loadDesktopSessionMock).toHaveBeenCalledTimes(1))
    const handler = (channel: string) => handleMock.mock.calls.find(
      ([registeredChannel]) => registeredChannel === channel,
    )?.[1]
    const loading = handler(IPC.authLoadSession)?.({})
    await vi.waitFor(() => expect(loadDesktopSessionMock).toHaveBeenCalledTimes(2))

    const clearing = handler(IPC.authClearSession)?.({})
    loadGate.resolve(storedSession('account-a', 'token-a'))

    await expect(loading).resolves.toBeNull()
    await expect(clearing).resolves.toBeUndefined()
  })

  it('serializes a late clear before the newer save intent reaches disk', async () => {
    const { IPC } = await import('@syrnike13/platform')
    const incidents = await import('./native-runtime/diagnostic-incidents')
    const { registerDesktopIpc } = await import('./ipc')
    incidents.clearNativeDiagnosticIncidentsForTests()
    const clearGate = deferred<void>()
    const diskOrder: string[] = []
    clearDesktopSessionMock.mockImplementationOnce(async () => {
      diskOrder.push('clear:start')
      await clearGate.promise
      diskOrder.push('clear:end')
    })
    saveDesktopSessionMock.mockImplementationOnce(async () => {
      diskOrder.push('save')
    })

    registerDesktopIpc(() => null, ipcOptions())
    const handler = (channel: string) => handleMock.mock.calls.find(
      ([registeredChannel]) => registeredChannel === channel,
    )?.[1]
    const clear = handler(IPC.authClearSession)
    const save = handler(IPC.authSaveSession)
    const enqueue = handler(IPC.diagnosticsEnqueueIncident)
    const clearing = clear?.({})
    await vi.waitFor(() => expect(clearDesktopSessionMock).toHaveBeenCalledTimes(1))

    const saving = save?.({}, storedSession('account-b', 'token-b'))
    expect(saveDesktopSessionMock).not.toHaveBeenCalled()
    clearGate.resolve()
    await Promise.all([clearing, saving])

    expect(diskOrder).toEqual(['clear:start', 'clear:end', 'save'])
    expect(enqueue?.({}, 'account-b', rendererIncident())).toBe(true)
  })

  it('revokes account-owned diagnostics before a failing disk clear settles', async () => {
    const { IPC } = await import('@syrnike13/platform')
    const incidents = await import('./native-runtime/diagnostic-incidents')
    const { registerDesktopIpc } = await import('./ipc')
    incidents.clearNativeDiagnosticIncidentsForTests()
    const clearGate = deferred<void>()
    clearDesktopSessionMock.mockImplementationOnce(() => clearGate.promise)

    registerDesktopIpc(() => null, ipcOptions())
    const handler = (channel: string) => handleMock.mock.calls.find(
      ([registeredChannel]) => registeredChannel === channel,
    )?.[1]
    const save = handler(IPC.authSaveSession)
    const clear = handler(IPC.authClearSession)
    const enqueue = handler(IPC.diagnosticsEnqueueIncident)
    await save?.({}, storedSession('account-a', 'token-a'))

    const clearing = clear?.({})
    const clearingExpectation = expect(clearing).rejects.toThrow('disk clear failed')
    expect(enqueue?.({}, 'account-a', rendererIncident())).toBe(false)
    clearGate.reject(new Error('disk clear failed'))
    await clearingExpectation
    expect(enqueue?.({}, 'account-a', rendererIncident())).toBe(false)
  })
})

function ipcOptions() {
  return {
    getWindowPreferences: () => ({ closeToTray: false, openAtLogin: false }),
    setCloseToTray: vi.fn(),
    setOpenAtLogin: vi.fn(),
    setTrayVoiceState: vi.fn(),
    updateLocalSettings: vi.fn(async () => ({} as never)),
    showWindow: vi.fn(),
    localSettingsPath: 'local-settings.json',
    sessionPath: 'session.json',
  }
}

function storedSession(userId: string, token: string) {
  return { _id: `session-${userId}`, user_id: userId, token }
}

function rendererIncident() {
  return {
    area: 'voice',
    severity: 'error',
    triggerCode: 'runtime_lost',
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
