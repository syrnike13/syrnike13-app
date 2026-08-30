import { Effect, Schema } from 'effect'
import type {
  RtcEngineAdapter,
  VoiceDisconnectCause,
  VoiceEngineEvent,
  VoiceFailure,
  VoiceLease,
  VoiceMediaDesiredState,
  VoiceMediaKind,
  VoiceRemoteAudioSettings,
} from '@syrnike13/platform'

const unavailableMessage =
  'Native media is unavailable while the v2 engine is rebuilt.'

export const NATIVE_MEDIA_UNAVAILABLE_FAILURE = {
  code: 'native_media_unavailable',
  message: unavailableMessage,
  retryable: false,
  stage: 'native_runtime',
} as const satisfies VoiceFailure

export class NativeMediaUnavailableError extends Schema.TaggedErrorClass<
  NativeMediaUnavailableError
>()('NativeMediaUnavailableError', {
  message: Schema.String,
  failure: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    retryable: Schema.Boolean,
    stage: Schema.optional(Schema.String),
    hresult: Schema.optional(Schema.Int),
  }),
}) {}

const unavailableError = () =>
  NativeMediaUnavailableError.make({
    message: unavailableMessage,
    failure: NATIVE_MEDIA_UNAVAILABLE_FAILURE,
  })

const unavailableEvent: VoiceEngineEvent = {
  type: 'availabilityChanged',
  available: false,
  retryable: false,
  failure: NATIVE_MEDIA_UNAVAILABLE_FAILURE,
}

/**
 * Explicit desktop boundary while the Windows native v2 engine is rebuilt.
 * It owns no native resources and never starts recovery or utility-process work.
 */
export class NativeRtcEngineAdapter implements RtcEngineAdapter {
  private readonly listeners = new Set<(event: VoiceEngineEvent) => void>()

  connect(
    _lease: VoiceLease,
    _desired: VoiceMediaDesiredState,
    _signal: AbortSignal,
  ): Promise<void> {
    // Voice Membership is authoritative and must survive an unavailable media
    // engine. Resolving here lets Voice Director commit membership while the
    // availability event keeps every media track explicitly unavailable.
    return Promise.resolve()
  }

  disconnect(_cause: VoiceDisconnectCause): Promise<void> {
    return Promise.resolve()
  }

  updateDesiredMedia(_desired: VoiceMediaDesiredState): void {}

  updateRemoteAudioSettings(_settings: VoiceRemoteAudioSettings): void {}

  retryMedia(_kind: VoiceMediaKind): void {}

  subscribe(listener: (event: VoiceEngineEvent) => void): () => void {
    this.listeners.add(listener)
    listener(unavailableEvent)
    return () => this.listeners.delete(listener)
  }

  prewarmMicrophoneEffect() {
    return Effect.fail(unavailableError())
  }

  telemetry() {
    return null
  }

  dispose(): void {
    this.listeners.clear()
  }
}
