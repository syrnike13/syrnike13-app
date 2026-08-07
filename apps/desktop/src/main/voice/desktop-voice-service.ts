import { powerMonitor, type BrowserWindow } from 'electron'
import {
  Context,
  Effect,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Schema,
  Semaphore,
} from 'effect'
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

class DesktopVoiceRuntimeResource extends Context.Service<
  DesktopVoiceRuntimeResource,
  DesktopVoiceRuntime
>()('syrnike13/DesktopVoiceRuntimeResource') {}

type OwnedDesktopVoiceRuntime = Readonly<{
  value: DesktopVoiceRuntime
  owner: ManagedRuntime.ManagedRuntime<DesktopVoiceRuntimeResource, never>
}>

export class DesktopVoiceService {
  private readonly listeners = new Set<(snapshot: VoiceSnapshot) => void>()
  private readonly effectRuntime = ManagedRuntime.make(Layer.empty)
  private readonly sessionLock = Semaphore.makeUnsafe(1)
  private runtime: DesktopVoiceRuntime
  private runtimeOwner: OwnedDesktopVoiceRuntime['owner']
  private sessionToken: string | null = null
  private sessionIdentity: string | null = null
  private sessionRevision = 0
  private sessionTransition: Fiber.Fiber<void, never> | null = null
  private preferences: DesktopVoiceSettings | null = null
  private lifecycleStarted = false
  private unsubscribeHotkeys: (() => void) | null = null
  private persistPreferences:
    | ((patch: DesktopVoiceSettingsPatch) => Promise<void> | void)
    | null = null
  private disposed = false

  constructor() {
    const initial = this.createOwnedRuntime()
    this.runtime = initial.value
    this.runtimeOwner = initial.owner
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

  private createOwnedRuntime(): OwnedDesktopVoiceRuntime {
    const owner = ManagedRuntime.make(
      Layer.effect(
        DesktopVoiceRuntimeResource,
        Effect.acquireRelease(
          Effect.sync(() => this.createRuntime()),
          (runtime) => this.disposeRuntime(runtime),
        ),
      ),
    )
    return {
      value: owner.runSync(DesktopVoiceRuntimeResource),
      owner,
    }
  }

  configureSession(session: DesktopStoredSession | null) {
    if (this.disposed) return
    const identity = session ? `${session.user_id}:${session._id}` : null
    if (identity === this.sessionIdentity) {
      if (!session || session.token === this.sessionToken) return
      this.sessionToken = session.token
      logNativeVoiceDiagnostic('session_token_refreshed')
      this.enqueueSessionTransition(
        Effect.sync(() => {
          if (
            !this.disposed &&
            this.sessionIdentity === identity &&
            this.sessionToken === session.token
          ) {
            this.runtime.transport.configure(
              desktopVoiceWebSocketUrl(),
              session.token,
            )
          }
        }),
      )
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
    this.enqueueSessionTransition(
      Effect.gen({ self: this }, function* () {
        const previousOwner = this.runtimeOwner
        yield* previousOwner.disposeEffect
        if (this.disposed || revision !== this.sessionRevision) return

        const replacement = this.createOwnedRuntime()
        this.runtime = replacement.value
        this.runtimeOwner = replacement.owner
        if (this.preferences) {
          this.applyPreferencesTo(replacement.value, this.preferences)
        }
        if (this.lifecycleStarted) {
          yield* replacement.value.engine.prewarmMicrophoneEffect().pipe(
            Effect.ignore,
          )
        }
        if (
          this.sessionIdentity === identity &&
          this.sessionToken
        ) {
          replacement.value.transport.configure(
            desktopVoiceWebSocketUrl(),
            this.sessionToken,
          )
          logNativeVoiceDiagnostic('session_configured', { rotated: true })
        }
      }),
    )
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
    this.effectRuntime.runFork(
      this.runtime.engine.prewarmMicrophoneEffect().pipe(Effect.ignore),
    )
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
      bypassSystemAudioInputProcessing:
        settings.bypassSystemAudioInputProcessing,
      automaticGainControl: settings.automaticGainControl,
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

  dispatch(command: VoiceCommand) {
    return this.effectRuntime.runPromise(
      Effect.gen({ self: this }, function*() {
        if (this.disposed) {
          return yield* Effect.fail(
            new Error('Desktop voice service is disposed'),
          )
        }
        yield* this.awaitSessionTransitionEffect()
        if (this.disposed) {
          return yield* Effect.fail(
            new Error('Desktop voice service is disposed'),
          )
        }
        if (command.type === 'join' && !this.sessionToken) {
          return yield* Effect.fail(
            new Error(
              'Desktop voice requires an authenticated session',
            ),
          )
        }
        logNativeVoiceDiagnostic('command', {
          command: command.type,
          connection: this.runtime.director.snapshot().connection,
        })
        this.runtime.director.dispatch(command)
        return this.runtime.director.snapshot()
      }),
    )
  }

  snapshot() {
    return this.runtime.director.snapshot()
  }

  subscribe(listener: (snapshot: VoiceSnapshot) => void) {
    this.listeners.add(listener)
    listener(this.runtime.director.snapshot())
    return () => this.listeners.delete(listener)
  }

  dispose() {
    return Effect.runPromise(this.disposeEffect())
  }

  disposeEffect() {
    return Effect.gen({ self: this }, function*() {
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
      yield* this.awaitSessionTransitionEffect()
      yield* this.sessionLock.withPermit(
        this.runtimeOwner.disposeEffect,
      )
      this.persistPreferences = null
      this.listeners.clear()
      yield* this.effectRuntime.disposeEffect
      logNativeVoiceDiagnostic('dispose_completed')
    })
  }

  private disposeRuntime(runtime: DesktopVoiceRuntime) {
    return Effect.gen(function* () {
      yield* ignoreRuntimeDisposalFailure(
        runtime.director.disposeEffect(),
        'director',
      )
      yield* ignoreRuntimeDisposalFailure(
        Effect.sync(() => runtime.unsubscribeDirector()),
        'director_subscription',
      )
      yield* ignoreRuntimeDisposalFailure(
        Effect.sync(() => runtime.engine.dispose()),
        'engine',
      )
      yield* ignoreRuntimeDisposalFailure(
        Effect.sync(() => runtime.authority.dispose()),
        'authority',
      )
      yield* ignoreRuntimeDisposalFailure(
        Effect.sync(() => runtime.transport.stop()),
        'transport',
      )
    })
  }

  private enqueueSessionTransition(effect: Effect.Effect<void>) {
    const transition = this.sessionLock.withPermit(effect).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          logNativeVoiceDiagnostic('session_rotation_failed', {
            message: String(cause),
          })
        }),
      ),
    )
    this.sessionTransition = this.effectRuntime.runFork(transition)
  }

  private awaitSessionTransitionEffect() {
    const transition = this.sessionTransition
    return transition ? Fiber.join(transition) : Effect.void
  }

  private readonly handleSuspend = () => {
    logNativeVoiceDiagnostic('system_suspend')
    Effect.runFork(this.runtime.director.shutdownEffect('sleep'))
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
    this.effectRuntime.runFork(
      Effect.tryPromise({
        try: async () => this.persistPreferences?.(patch),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            logNativeVoiceDiagnostic('preference_persist_failed')
          }),
        ),
      ),
    )
  }
}

export function desktopVoiceWebSocketUrl() {
  return typeof __DESKTOP_VOICE_WS_URL__ === 'string'
    ? __DESKTOP_VOICE_WS_URL__
    : `wss://${DESKTOP_RELEASE_METADATA.publicHost}/ws`
}

function desktopVoiceApiUrl() {
  return typeof __DESKTOP_API_URL__ === 'string'
    ? __DESKTOP_API_URL__
    : `https://${DESKTOP_RELEASE_METADATA.publicHost}/api`
}

let voiceNodePromise: Promise<string> | null = null

const VoiceNodeRootSchema = Schema.Struct({
  features: Schema.optional(Schema.Struct({
    livekit: Schema.optional(Schema.Struct({
      nodes: Schema.optional(Schema.Array(Schema.Struct({
        name: Schema.optional(Schema.String),
      }))),
    })),
  })),
})

const discoverDesktopVoiceNode = Effect.fn('desktopVoice.discoverNode')(
  function*() {
    const response = yield* Effect.tryPromise({
      try: () => fetch(desktopVoiceApiUrl()),
      catch: (cause) => cause,
    })
    if (!response.ok) {
      return yield* Effect.fail(new Error('Voice node discovery failed'))
    }
    const root = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) => cause,
    })
    const decoded = Schema.decodeUnknownOption(VoiceNodeRootSchema)(root)
    if (Option.isNone(decoded)) return 'worldwide'
    const name = decoded.value.features?.livekit?.nodes?.[0]?.name
    return name && name.length > 0 ? name : 'worldwide'
  },
)

function resolveDesktopVoiceNode() {
  if (!voiceNodePromise) {
    voiceNodePromise = Effect.runPromise(
      discoverDesktopVoiceNode().pipe(
        Effect.catchIf(() => true, () => Effect.succeed('worldwide')),
      ),
    )
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

function ignoreRuntimeDisposalFailure(
  effect: Effect.Effect<void>,
  component: string,
) {
  return effect.pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        logNativeVoiceDiagnostic('runtime_dispose_failed', {
          component,
          message: String(cause),
        })
      }),
    ),
  )
}
