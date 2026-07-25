import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
  },
  ipcMain: { handle: vi.fn() },
  utilityProcess: { fork: vi.fn() },
}))

describe('native media runtime façade', () => {
  it('exposes controller-backed runtime lifecycle and IPC registration', async () => {
    const runtime = await import('./native-media-engine')
    expect(runtime.getNativeMediaController()).toBeDefined()
    expect(runtime.registerNativeMediaRuntimeIpc).toEqual(expect.any(Function))
    expect(runtime.startNativeMediaRuntime).toEqual(expect.any(Function))
    expect(runtime.disposeNativeMediaRuntime).toEqual(expect.any(Function))
  })

  it('resets renderer-owned media only for a full main-frame navigation', async () => {
    const { isRendererReplacementNavigation } = await import('./native-media-engine')

    expect(isRendererReplacementNavigation(false, true)).toBe(true)
    expect(isRendererReplacementNavigation(true, true)).toBe(false)
    expect(isRendererReplacementNavigation(false, false)).toBe(false)
  })

  it('enables local native diagnostics by default with an explicit opt-out', async () => {
    const { nativeMediaDiagnosticsEnabled } = await import('./native-media-engine')

    expect(nativeMediaDiagnosticsEnabled('win32', undefined)).toBe(true)
    expect(nativeMediaDiagnosticsEnabled('win32', '1')).toBe(true)
    expect(nativeMediaDiagnosticsEnabled('win32', '0')).toBe(false)
    expect(nativeMediaDiagnosticsEnabled('linux', undefined)).toBe(false)
  })
})
