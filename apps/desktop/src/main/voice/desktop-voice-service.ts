import { powerMonitor, type BrowserWindow } from 'electron'
import {
  GatewayVoiceAuthorityAdapter,
  VoiceDirector,
  type DesktopStoredSession,
  type DesktopVoiceSettings,
  type DesktopVoiceSettingsPatch,
  type VoiceCommand,
  type VoiceSnapshot,
} from '@syrnike13/platform'

import {
  createNativeRtcEngineAdapter,
  logNativeVoiceDiagnostic,
} from '../native-media-engine'
import { DESKTOP_RELEASE_METADATA } from '../desktop-app-identity'
import { subscribeHotkeyActivations } from '../hotkeys'
import { DesktopVoiceGatewayTransport } from './desktop-voice-gateway-transport'

type DesktopVoiceRuntime = {
  transport: DesktopVoiceGatewayTransport
  authority: GatewayVoiceAuthorityAdapter
  engine: ReturnType<typeof createNativeRtcEngineAdapter>
  director: VoiceDirector
  unsubscribeDirector: () => void
}

export class DesktopVoiceService {
  private readonly listeners = new Set<(snapshot: VoiceSnapshot) => void>()
  private runtime: DesktopVoiceRuntime
  private sessionToken: string | null = null
  private sessionIdentity: string | null = null
  private sessionRevision = 0
  private sessionTransition: Promise<void> = Promise.resolve()
  private preferences: DesktopVoiceSettings | null = null
  private lifecycleStarted = false
  private unsubscribeHotkeys: (() => void) | null = null
  private persistPreferences:
    | ((patch: DesktopVoiceSettingsPatch) => Promise<void> | void)
    | null = null
  private disposed = false

  constructor() {
    this.runtime = this.createRuntime()
  }

  private createRuntime(): DesktopVoiceRuntime {
    const transport = new DesktopVoiceGatewayTransport({
      diagnostics: logNativeVoiceDiagnostic,
    })
    const authority = new GatewayVoiceAuthorityAdapter({
      transport,
      resolveJoinMetadata: async () => ({
        node: await resolveDesktopVoiceNode(),
      }),
    })
    const engine = createNativeRtcEngineAdapter()
    const director = new VoiceDirector({
      authority,
      engine,
      rtcEngine: 'windows_native',
      clientInstanceId: `desktop-${crypto.randomUUID()}`,
    })
    const unsubscribeDirector = director.subscribe((snapshot) => {
      logNativeVoiceDiagnostic('snapshot', {
        connection: snapshot.connection,
        operationId: snapshot.operationId,
        connectionEpoch: snapshot.connectionEpoch,
        microphone: snapshot.microphone.state,
        output: snapshot.output.state,
        camera: snapshot.camera.state,
        screen: snapshot.screen.state,
        effectiveMuted: snapshot.effectiveMuted,
        userDeafened: snapshot.userDeafened,
        serverMuted: snapshot.serverMuted,
        serverDeafened: snapshot.serverDeafened,
        retryAttempt: snapshot.retryAttempt,
        failureCode: snapshot.failure?.code,
        failureStage: snapshot.failure?.stage,
      })
      for (const listener of this.listeners) listener(snapshot)
    })
    return { transport, authority, engine, director, unsubscribeDirector }
  }

  configureSession(session: DesktopStoredSession | null) {
    if (this.disposed) return
    const identity = session ? `${session.user_id}:${session._id}` : null
    if (identity === this.sessionIdentity) {
      if (!session || session.token === this.sessionToken) return
      this.sessionToken = session.token
      logNativeVoiceDiagnostic('session_token_refreshed')
      this.runtime.transport.configure(desktopVoiceWebSocketUrl(), session.token)
      return
    }

    const revision = ++this.sessionRevision
    const previousIdentity = this.sessionIdentity
    this.sessionIdentity = identity
    this.sessionToken = session?.token ?? null
    logNativeVoiceDiagnostic(session ? 'session_rotating' : 'session_cleared', {
      accountChanged:
        previousIdentity !== null &&
        session !== null &&
        !previousIdentity.startsWith(`${session.user_id}:`),
    })
    this.sessionTransition = this.sessionTransition
      .catch(() => undefined)
      .then(async () => {
        const previous = this.runtime
        await this.disposeRuntime(previous)
        if (this.disposed) return
        const replacement = this.createRuntime()
        this.runtime = replacement
        if (this.preferences) this.applyPreferencesTo(replacement, this.preferences)
        if (this.lifecycleStarted) {
          void replacement.engine.prewarmMicrophone().catch(() => undefined)
        }
        if (
          revision === this.sessionRevision &&
          this.sessionIdentity === identity &&
          this.sessionToken
        ) {
          replacement.transport.configure(desktopVoiceWebSocketUrl(), this.sessionToken)
          logNativeVoiceDiagnostic('session_configured', { rotated: true })
        }
      })
      .catch((error) => {
        logNativeVoiceDiagnostic('session_rotation_failed', {
          message: error instanceof Error ? error.message : 'Unknown session rotation failure',
        })
      })
  }

  startSystemLifecycle() {
    if (this.lifecycleStarted || this.disposed) return
    this.lifecycleStarted = true
    powerMonitor.on('suspend', this.handleSuspend)
    powerMonitor.on('lock-screen', this.handleLock)
    powerMonitor.on('unlock-screen', this.handleUnlock)
    this.unsubscribeHotkeys = subscribeHotkeyActivations((event) => {
      this.handleHotkey(event.action, event.phase)
    })
    logNativeVoiceDiagnostic('system_lifecycle_started')
    void this.runtime.engine.prewarmMicrophone().catch(() => undefined)
  }

  applyPreferences(settings: DesktopVoiceSettings) {
    if (this.disposed) return
    this.preferences = settings
    this.applyPreferencesTo(this.runtime, settings)
  }

  private applyPreferencesTo(
    runtime: DesktopVoiceRuntime,
    settings: DesktopVoiceSettings,
  ) {
    runtime.director.dispatch({
      type: 'setUserMuted',
      muted: !settings.micEnabled,
    })
    runtime.director.dispatch({
      type: 'setUserDeafened',
      deafened: settings.deafened,
    })
    runtime.director.dispatch({
      type: 'configureMicrophone',
      deviceId: settings.preferredAudioInputDevice,
      noiseSuppression: settings.noiseSuppression,
      echoCancellation: settings.echoCancellation,
      inputVolume: settings.inputVolume,
      voiceGateEnabled: settings.voiceGateEnabled,
      voiceGateThresholdDb: settings.voiceGateThresholdDb,
      voiceGateAutoThreshold: settings.voiceGateAutoThreshold,
    })
    runtime.director.dispatch({
      type: 'configureOutput',
      deviceId: settings.preferredAudioOutputDevice,
      volume: settings.outputVolume,
    })
  }

  setPreferencePersistence(
    persist: (patch: DesktopVoiceSettingsPatch) => Promise<void> | void,
  ) {
    this.persistPreferences = persist
  }

  async dispatch(command: VoiceCommand) {
    if (this.disposed) throw new Error('Desktop voice service is disposed')
    await this.sessionTransition
    if (this.disposed) throw new Error('Desktop voice service is disposed')
    if (command.type === 'join' && !this.sessionToken) {
      throw new Error('Desktop voice requires an authenticated session')
    }
    logNativeVoiceDiagnostic('command', {
      command: command.type,
      connection: this.runtime.director.snapshot().connection,
    })
    this.runtime.director.dispatch(command)
    return this.runtime.director.snapshot()
  }

  snapshot() {
    return this.runtime.director.snapshot()
  }

  subscribe(listener: (snapshot: VoiceSnapshot) => void) {
    this.listeners.add(listener)
    listener(this.runtime.director.snapshot())
    return () => this.listeners.delete(listener)
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    logNativeVoiceDiagnostic('dispose_started')
    if (this.lifecycleStarted) {
      powerMonitor.removeListener('suspend', this.handleSuspend)
      powerMonitor.removeListener('lock-screen', this.handleLock)
      powerMonitor.removeListener('unlock-screen', this.handleUnlock)
      this.unsubscribeHotkeys?.()
      this.unsubscribeHotkeys = null
    }
    await this.sessionTransition.catch(() => undefined)
    await this.disposeRuntime(this.runtime)
    this.persistPreferences = null
    this.listeners.clear()
    logNativeVoiceDiagnostic('dispose_completed')
  }

  private async disposeRuntime(runtime: DesktopVoiceRuntime) {
    await runtime.director.dispose()
    runtime.unsubscribeDirector()
    runtime.engine.dispose()
    runtime.authority.dispose()
    runtime.transport.stop()
  }

  private readonly handleSuspend = () => {
    logNativeVoiceDiagnostic('system_suspend')
    void this.runtime.director.shutdown('sleep')
  }

  private readonly handleLock = () => {
    logNativeVoiceDiagnostic('system_lock')
    this.runtime.director.dispatch({ type: 'setSystemPrivacyMuted', muted: true })
  }

  private readonly handleUnlock = () => {
    logNativeVoiceDiagnostic('system_unlock')
    this.runtime.director.dispatch({ type: 'setSystemPrivacyMuted', muted: false })
  }

  private handleHotkey(
    action:
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
      | 'toggle-vad',
    phase: 'pressed' | 'released',
  ) {
    logNativeVoiceDiagnostic('hotkey', { action, phase })
    const snapshot = this.runtime.director.snapshot()
    if (action === 'push-to-talk' || action === 'priority-push-to-talk') {
      this.runtime.director.dispatch({
        type: 'setPushToTalkHeld',
        held: phase === 'pressed',
      })
      return
    }
    if (action === 'push-to-mute') {
      this.runtime.director.dispatch({
        type: 'setSelfMonitoringActive',
        active: phase === 'pressed',
      })
      return
    }
    if (phase !== 'pressed') return
    if (action === 'toggle-mic') {
      if (snapshot.userDeafened) {
        this.runtime.director.dispatch({
          type: 'setUserDeafened',
          deafened: false,
        })
        this.persistPreference({ deafened: false })
        return
      }
      const micEnabled = snapshot.userMuted
      this.runtime.director.dispatch({
        type: 'setUserMuted',
        muted: !micEnabled,
      })
      this.persistPreference({ micEnabled })
    } else if (action === 'toggle-deafen') {
      const deafened = !snapshot.userDeafened
      this.runtime.director.dispatch({
        type: 'setUserDeafened',
        deafened,
      })
      this.persistPreference({ deafened })
    } else if (action === 'toggle-camera') {
      this.runtime.director.dispatch({
        type: 'setCamera',
        enabled:
          snapshot.camera.state === 'off' || snapshot.camera.state === 'failed',
      })
    } else if (action === 'disconnect-voice') {
      this.runtime.director.dispatch({ type: 'leave' })
    } else if (action === 'toggle-vad') {
      this.runtime.director.dispatch({
        type: 'setInputMode',
        mode:
          snapshot.inputMode === 'voice_activity'
            ? 'push_to_talk'
            : 'voice_activity',
      })
    }
  }

  private persistPreference(patch: DesktopVoiceSettingsPatch) {
    try {
      void Promise.resolve(this.persistPreferences?.(patch)).catch(() => {
        logNativeVoiceDiagnostic('preference_persist_failed')
      })
    } catch {
      logNativeVoiceDiagnostic('preference_persist_failed')
      // A settings write must never break hotkey handling or the RTC session.
    }
  }
}

export function desktopVoiceWebSocketUrl() {
  return `wss://${DESKTOP_RELEASE_METADATA.publicHost}/ws`
}

let voiceNodePromise: Promise<string> | null = null

async function resolveDesktopVoiceNode() {
  if (!voiceNodePromise) {
    voiceNodePromise = fetch(
      `https://${DESKTOP_RELEASE_METADATA.publicHost}/api`,
    )
      .then(async (response) => {
        if (!response.ok) throw new Error('Voice node discovery failed')
        const root = (await response.json()) as {
          features?: { livekit?: { nodes?: Array<{ name?: unknown }> } }
        }
        const name = root.features?.livekit?.nodes?.[0]?.name
        return typeof name === 'string' && name.length > 0
          ? name
          : 'worldwide'
      })
      .catch(() => 'worldwide')
  }
  return voiceNodePromise
}

export function broadcastDesktopVoiceSnapshot(
  getWindow: () => BrowserWindow | null,
  channel: string,
  snapshot: VoiceSnapshot,
) {
  const webContents = getWindow()?.webContents
  if (!webContents || webContents.isDestroyed()) return
  webContents.send(channel, snapshot)
}

export const desktopVoiceService = new DesktopVoiceService()
