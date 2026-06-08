import type {
  NativeMediaDeviceInfo,
  NativeMicrophoneRuntimeConfig,
  NativeMicrophonePreviewSession,
  NativeMicrophonePreviewStartOptions,
  NativeMediaSession,
  NativeMediaSessionStartOptions,
  NativeMediaState,
  NativeMediaStateEvent,
  NativeMediaStatsEvent,
} from './media'

/** Где выполняется UI: браузер или оболочка Electron. */
export type SyrnikeRuntime = 'web' | 'desktop'

/** ОС настольной оболочки (совпадает с Node `process.platform`). */
export type DesktopOs = 'darwin' | 'win32' | 'linux'

export interface DesktopPlatformInfo {
  os: DesktopOs
}

export interface DesktopVersions {
  app: string
  electron: string
  chrome: string
  node: string
}

export interface ActivityDetails {
  type: 'playing' | 'listening' | 'watching'
  name: string
  details?: string
  state?: string
}

export interface DesktopWindowPreferences {
  closeToTray: boolean
  openAtLogin: boolean
}

export interface DesktopStoredSession {
  _id: string
  token: string
  user_id: string
}

export type DesktopUpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string }
  | { status: 'downloading'; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'error'; message: string }

export type HotkeyAction =
  | 'toggle-mic'
  | 'toggle-deafen'
  | 'toggle-camera'
  | 'toggle-screen-share'
  | 'return-to-voice'
  | 'disconnect-voice'
  | 'navigate-back'
  | 'navigate-forward'
  | 'push-to-talk'
  | 'push-to-mute'
  | 'priority-push-to-talk'
  | 'toggle-vad'

export type HotkeyModifier = 'ctrl' | 'alt' | 'shift' | 'meta'

export type HotkeyModifiers = Record<HotkeyModifier, boolean>

export type HotkeyTrigger =
  | {
      type: 'keyboard'
      code: string
      key: string
    }
  | {
      type: 'mouse'
      button: 'Mouse4' | 'Mouse5'
    }
  | {
      type: 'modifier'
      modifier: HotkeyModifier
    }

export type HotkeyCombo = {
  trigger: HotkeyTrigger
  modifiers: HotkeyModifiers
}

export type HotkeyBinding = {
  id: string
  action: HotkeyAction
  combo: HotkeyCombo | null
  enabled: boolean
}

export type HotkeyRegistrationStatus =
  | 'registered'
  | 'disabled'
  | 'invalid'
  | 'taken'
  | 'unsupported'

export type NativeInputEvent =
  | {
      type: 'keyDown' | 'keyUp'
      code: string
      key: string
      modifiers: HotkeyModifiers
    }
  | {
      type: 'mouseDown' | 'mouseUp'
      button: 'Mouse4' | 'Mouse5'
      modifiers: HotkeyModifiers
    }

export type HotkeyRuntimeStatus =
  | 'running'
  | 'not-running'
  | 'unsupported-platform'
  | 'permission-required'

export type HotkeyRegistrationResult = {
  id: string
  status: HotkeyRegistrationStatus
}

export type HotkeyActivationEvent = {
  action: HotkeyAction
  phase: 'pressed' | 'released'
}

export type DesktopDisplayMediaSourceType = 'screen' | 'window'

export type DesktopDisplayMediaSource = {
  id: string
  name: string
  type: DesktopDisplayMediaSourceType
  thumbnailDataUrl: string | null
  appIconDataUrl: string | null
}

export type DesktopDisplayMediaRequest = {
  id: string
  audioRequested: boolean
  /** Видео идёт через нативный sidecar, не через desktopCapturer. */
  nativeVideo?: boolean
}

export type {
  NativeMediaEncoderBackend,
  NativeMediaDeviceInfo,
  NativeMediaFrameMethod,
  NativeMediaFrameStats,
  NativeMediaSession,
  NativeMediaSidecarLostEvent,
  NativeMediaSessionKind,
  NativeMediaSessionStartOptions,
  NativeMicrophonePreviewSession,
  NativeMicrophonePreviewStartOptions,
  NativeMediaScreenSessionStartOptions,
  NativeMediaState,
  NativeMediaStateEvent,
  NativeMediaStatsEvent,
  NativeMediaStreamMode,
  NativeMediaTarget,
} from './media'

/**
 * API, который preload пробрасывает в `window.syrnikeDesktop`.
 * Расширяйте по мере появления нативных возможностей (presence, screen share, …).
 */
export interface SyrnikeDesktopApi {
  readonly runtime: 'desktop'
  readonly platform: DesktopPlatformInfo
  getVersions(): Promise<DesktopVersions>
  window: {
    minimize(): void
    maximize(): void
    close(): void
    show(): void
    isMaximized(): Promise<boolean>
    getPreferences(): Promise<DesktopWindowPreferences>
    setCloseToTray(closeToTray: boolean): Promise<DesktopWindowPreferences>
    setOpenAtLogin(openAtLogin: boolean): Promise<DesktopWindowPreferences>
  }
  activity: {
    set(details: ActivityDetails | null): Promise<void>
    clear(): Promise<void>
  }
  auth: {
    loadSession(): Promise<DesktopStoredSession | null>
    saveSession(session: DesktopStoredSession): Promise<void>
    clearSession(): Promise<void>
  }
  updates: {
    getState(): Promise<DesktopUpdateState>
    check(): Promise<DesktopUpdateState>
    install(): void
    onStateChange(handler: (state: DesktopUpdateState) => void): () => void
  }
  hotkeys: {
    getBindings(): Promise<HotkeyBinding[]>
    setBindings(
      bindings: HotkeyBinding[],
    ): Promise<HotkeyRegistrationResult[]>
    setSuspended(suspended: boolean): Promise<void>
    startRecording(): Promise<void>
    stopRecording(): Promise<void>
    getRuntimeStatus(): Promise<HotkeyRuntimeStatus>
    onRecordedInput(handler: (event: NativeInputEvent) => void): () => void
    onPressed(handler: (event: HotkeyActivationEvent) => void): () => void
  }
  media: {
    getDisplaySources(requestId: string): Promise<DesktopDisplayMediaSource[]>
    selectDisplaySource(requestId: string, sourceId: string): Promise<boolean>
    cancelRequest(requestId: string): Promise<void>
    openDisplayPicker(audioRequested: boolean): Promise<DesktopDisplayMediaRequest>
    listDevices(kind: 'audioinput'): Promise<NativeMediaDeviceInfo[]>
    startMicrophonePreview(
      options: NativeMicrophonePreviewStartOptions,
    ): Promise<NativeMicrophonePreviewSession>
    stopMicrophonePreview(sessionId?: string): Promise<void>
    onRequest(handler: (request: DesktopDisplayMediaRequest) => void): () => void
    onDisplayPickerResolved(
      handler: (payload: { requestId: string; sourceId: string }) => void,
    ): () => void
    startSession(options: NativeMediaSessionStartOptions): Promise<NativeMediaSession>
    configureMicrophoneRuntime(
      sessionId: string,
      config: NativeMicrophoneRuntimeConfig,
    ): Promise<void>
    stopSession(sessionId?: string): Promise<void>
    getState(): Promise<NativeMediaState>
    onStats(handler: (event: NativeMediaStatsEvent) => void): () => void
    onMicrophoneMetrics(
      handler: (event: import('./media').NativeMicrophoneMetricsEvent) => void,
    ): () => void
    onStateChange(handler: (event: NativeMediaStateEvent) => void): () => void
    readSharedFrame(sessionId: string): Promise<ArrayBuffer | null>
    onStreamChunk(
      handler: (event: { sessionId: string; chunk: ArrayBuffer }) => void,
    ): () => void
    onStreamAudioChunk(
      handler: (event: { sessionId: string; chunk: ArrayBuffer }) => void,
    ): () => void
    onStreamEnded(handler: (sessionId: string) => void): () => void
    onStreamError(
      handler: (event: { sessionId: string; message: string }) => void,
    ): () => void
    onSidecarLost(
      handler: (event: import('./media').NativeMediaSidecarLostEvent) => void,
    ): () => void
  }
}
