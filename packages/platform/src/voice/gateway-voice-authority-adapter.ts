import { Effect, Exit, Layer, ManagedRuntime, Option, Schema } from 'effect'

import type {
  VoiceAuthorityAdapter,
  VoiceAuthorityEvent,
  VoiceCancellation,
  VoiceReservationRequest,
  VoiceSelfStateUpdate,
} from './voice-authority'
import type {
  AuthoritativeVoiceSnapshot,
  VoiceLease,
  VoiceMembership,
  VoiceRtcEngine,
} from './voice-types'

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

const ProtocolString = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
)
const VoiceUrl = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2_048),
  Schema.makeFilter((value) =>
    isAllowedVoiceUrl(value) ? undefined : 'Expected a WebSocket URL',
  ),
)
const VoiceToken = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(32_768),
)
const VoiceRtcEngineSchema = Schema.Literals(['web', 'windows_native'])
const AuthorityVersion = Schema.Natural

const CredentialSchema = Schema.Struct({
  rtc_engine: VoiceRtcEngineSchema,
  client_instance_id: ProtocolString,
  connection_epoch: ProtocolString,
  token: VoiceToken,
  identity: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(2_048),
  ),
})

const VoiceLeaseSchema = Schema.Struct({
  operation_id: ProtocolString,
  authority_version: AuthorityVersion,
  channel_id: ProtocolString,
  url: VoiceUrl,
  credential: CredentialSchema,
})

const VoiceMembershipSchema = Schema.Struct({
  operation_id: ProtocolString,
  channel_id: ProtocolString,
  rtc_engine: VoiceRtcEngineSchema,
  client_instance_id: ProtocolString,
  connection_epoch: ProtocolString,
})

const AuthoritySnapshotSchema = Schema.Struct({
  version: AuthorityVersion,
  operation_id: Schema.optional(Schema.NullOr(ProtocolString)),
  channel_id: Schema.optional(Schema.NullOr(ProtocolString)),
  rtc_engine: Schema.optional(Schema.NullOr(VoiceRtcEngineSchema)),
  client_instance_id: Schema.optional(Schema.NullOr(ProtocolString)),
  connection_epoch: Schema.optional(Schema.NullOr(ProtocolString)),
  state: Schema.optional(
    Schema.Struct({
      server_muted: Schema.optional(Schema.Boolean),
      server_deafened: Schema.optional(Schema.Boolean),
    }),
  ),
})

const GatewayEventSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('Bulk'),
    v: Schema.Array(Schema.Unknown),
  }),
  Schema.Struct({
    type: Schema.Literal('VoiceServerUpdate'),
    operation_id: ProtocolString,
    authority_version: AuthorityVersion,
    channel_id: ProtocolString,
    url: VoiceUrl,
    credential: CredentialSchema,
  }),
  Schema.Struct({
    type: Schema.Literal('VoiceAuthoritySnapshot'),
    version: AuthorityVersion,
    operation_id: Schema.optional(Schema.NullOr(ProtocolString)),
    channel_id: Schema.optional(Schema.NullOr(ProtocolString)),
    rtc_engine: Schema.optional(Schema.NullOr(VoiceRtcEngineSchema)),
    client_instance_id: Schema.optional(Schema.NullOr(ProtocolString)),
    connection_epoch: Schema.optional(Schema.NullOr(ProtocolString)),
    state: Schema.optional(
      Schema.Struct({
        server_muted: Schema.optional(Schema.Boolean),
        server_deafened: Schema.optional(Schema.Boolean),
      }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal('VoiceAuthorityMove'),
    from: VoiceMembershipSchema,
    lease: VoiceLeaseSchema,
  }),
  Schema.Struct({
    type: Schema.Literal('Ready'),
    voice_authority: Schema.optional(AuthoritySnapshotSchema),
  }),
  Schema.Struct({
    type: Schema.Literal('VoiceStateAck'),
    nonce: ProtocolString,
    ok: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal('Error'),
    request: Schema.optional(
      Schema.Struct({
        nonce: Schema.optional(ProtocolString),
        operation_id: Schema.optional(ProtocolString),
      }),
    ),
    data: Schema.optional(
      Schema.Struct({
        message: Schema.optional(Schema.String),
      }),
    ),
  }),
])

type GatewayEvent = typeof GatewayEventSchema.Type
type AuthoritySnapshotPayload = typeof AuthoritySnapshotSchema.Type

const VoiceFailureSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
  stage: Schema.Literal('voice_authority'),
})

class VoiceAuthorityRequestError extends Schema.ErrorClass<VoiceAuthorityRequestError>(
  'syrnike13/VoiceAuthorityRequestError',
)({
  _tag: Schema.tag('VoiceAuthorityRequestError'),
  message: Schema.String,
  failure: VoiceFailureSchema,
}) {}

class VoiceAuthorityStateError extends Schema.ErrorClass<VoiceAuthorityStateError>(
  'syrnike13/VoiceAuthorityStateError',
)({
  _tag: Schema.tag('VoiceAuthorityStateError'),
  message: Schema.String,
}) {}

class VoiceAuthorityMetadataError extends Schema.ErrorClass<VoiceAuthorityMetadataError>(
  'syrnike13/VoiceAuthorityMetadataError',
)({
  _tag: Schema.tag('VoiceAuthorityMetadataError'),
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

type VoiceAuthorityOperationError =
  | VoiceAuthorityRequestError
  | VoiceAuthorityStateError
  | VoiceAuthorityMetadataError
  | DOMException

export type VoiceGatewayTransportState = 'connected' | 'unavailable'

export interface VoiceGatewayTransport {
  sendReliable(message: Record<string, unknown>, key: string): void
  subscribeEvents(listener: (event: Record<string, unknown>) => void): () => void
  subscribeState(
    listener: (state: VoiceGatewayTransportState) => void,
  ): () => void
}

export type GatewayVoiceAuthorityAdapterOptions = Readonly<{
  transport: VoiceGatewayTransport
  requestTimeoutMs?: number
  resolveJoinMetadata?: (
    request: VoiceReservationRequest,
  ) =>
    | Promise<{
        node?: string
        recipients?: readonly string[]
        suppressCallNotifications?: boolean
      }>
    | {
        node?: string
        recipients?: readonly string[]
        suppressCallNotifications?: boolean
      }
}>

type PendingLease = Readonly<{
  request: VoiceReservationRequest
  resume: (
    effect: Effect.Effect<VoiceLease, VoiceAuthorityOperationError>,
  ) => void
}>

type PendingAck = Readonly<{
  resume: (
    effect: Effect.Effect<void, VoiceAuthorityOperationError>,
  ) => void
}>

/** Shared, strict voice-authority protocol used by web and Electron main. */
export class GatewayVoiceAuthorityAdapter implements VoiceAuthorityAdapter {
  private readonly listeners = new Set<(event: VoiceAuthorityEvent) => void>()
  private readonly pendingLeases = new Map<string, PendingLease>()
  private readonly pendingAcks = new Map<string, PendingAck>()
  private readonly requestTimeoutMs: number
  private readonly unsubscribeEvents: () => void
  private readonly unsubscribeState: () => void
  private readonly runtime = ManagedRuntime.make(Layer.empty)
  private disposed = false
  private nonceCounter = 0

  constructor(private readonly options: GatewayVoiceAuthorityAdapterOptions) {
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.unsubscribeEvents = options.transport.subscribeEvents((event) =>
      this.handleEvent(event),
    )
    this.unsubscribeState = options.transport.subscribeState((state) => {
      this.emit({
        type: state === 'connected' ? 'controlReady' : 'controlUnavailable',
      })
      if (state === 'connected') {
        this.runtime.runFork(this.requestSnapshotEffect().pipe(Effect.ignore))
      }
    })
  }

  reserve(request: VoiceReservationRequest, signal: AbortSignal) {
    return this.runtime.runPromise(
      Effect.gen({ self: this }, function* () {
        yield* this.ensureAvailable()
        if (signal.aborted) return yield* Effect.fail(abortError())
        if (this.pendingLeases.has(request.operationId)) {
          return yield* Effect.fail(
            stateError('Duplicate voice operation id'),
          )
        }

        const metadata = yield* this.resolveJoinMetadata(request)
        if (signal.aborted) return yield* Effect.fail(abortError())

        const waitForLease = this.waitForLease(request, metadata).pipe(
          Effect.timeoutOrElse({
            duration: this.requestTimeoutMs,
            orElse: () =>
              Effect.fail(
                authorityError(
                  'voice_authority_timeout',
                  'Voice authority did not return an RTC lease',
                  true,
                ),
              ),
          }),
          Effect.raceFirst(abortSignal(signal)),
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? Effect.sync(() => this.releasePendingClaim(request))
              : Effect.void,
          ),
        )

        return yield* waitForLease
      }),
    )
  }

  cancel(input: VoiceCancellation) {
    return this.runAckRequest(
      {
        request: authorityClaim('disconnect', input),
        channelId: null,
        userMuted: false,
        userDeafened: false,
      },
      `voice-operation:${input.operationId}`,
    )
  }

  updateSelfState(input: VoiceSelfStateUpdate) {
    return this.runAckRequest(
      {
        request: authorityClaim('update_flags', input),
        channelId: input.channelId,
        userMuted: input.userMuted || input.userDeafened,
        userDeafened: input.userDeafened,
        suppressCallNotifications: true,
      },
      `voice-flags:${input.operationId}`,
    )
  }

  requestSnapshot() {
    return this.runtime.runPromise(this.requestSnapshotEffect())
  }

  private requestSnapshotEffect() {
    return this.runAckRequestEffect(
      {
        request: { mode: 'request_snapshot' },
        channelId: null,
        userMuted: false,
        userDeafened: false,
      },
      'voice-authority-snapshot',
    )
  }

  subscribe(listener: (event: VoiceAuthorityEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeEvents()
    this.unsubscribeState()

    for (const pending of this.pendingLeases.values()) {
      pending.resume(
        Effect.fail(stateError('Voice authority adapter disposed')),
      )
    }
    for (const pending of this.pendingAcks.values()) {
      pending.resume(
        Effect.fail(stateError('Voice authority adapter disposed')),
      )
    }

    this.pendingLeases.clear()
    this.pendingAcks.clear()
    this.listeners.clear()
    Effect.runFork(this.runtime.disposeEffect)
  }

  private ensureAvailable() {
    return this.disposed
      ? Effect.fail(stateError('Voice authority adapter is disposed'))
      : Effect.void
  }

  private resolveJoinMetadata(request: VoiceReservationRequest) {
    const resolver = this.options.resolveJoinMetadata
    if (!resolver) return Effect.succeed(undefined)
    return Effect.tryPromise({
      try: () => Promise.resolve(resolver(request)),
      catch: (cause) =>
        new VoiceAuthorityMetadataError({
          message: 'Failed to resolve voice join metadata',
          cause,
        }),
    })
  }

  private waitForLease(
    request: VoiceReservationRequest,
    metadata:
      | {
          node?: string
          recipients?: readonly string[]
          suppressCallNotifications?: boolean
        }
      | undefined,
  ) {
    return Effect.callback<VoiceLease, VoiceAuthorityOperationError>((resume) => {
      if (this.disposed) {
        resume(Effect.fail(stateError('Voice authority adapter is disposed')))
        return
      }
      if (this.pendingLeases.has(request.operationId)) {
        resume(Effect.fail(stateError('Duplicate voice operation id')))
        return
      }

      const pending: PendingLease = { request, resume }
      this.pendingLeases.set(request.operationId, pending)
      try {
        const nonce = this.createNonce()
        this.options.transport.sendReliable(
          voiceStateUpdateMessage({
            nonce,
            request: authorityClaim('join', request),
            channelId: request.channelId,
            userMuted: request.media.userMuted || request.media.userDeafened,
            userDeafened: request.media.userDeafened,
            node: metadata?.node,
            recipients: metadata?.recipients ?? request.recipients,
            suppressCallNotifications:
              metadata?.suppressCallNotifications ??
              request.suppressCallNotifications,
          }),
          `voice-operation:${request.operationId}`,
        )
      } catch (cause) {
        this.pendingLeases.delete(request.operationId)
        resume(
          Effect.fail(
            new VoiceAuthorityMetadataError({
              message: 'Failed to send voice authority request',
              cause,
            }),
          ),
        )
      }

      return Effect.sync(() => {
        if (this.pendingLeases.get(request.operationId) === pending) {
          this.pendingLeases.delete(request.operationId)
        }
      })
    })
  }

  private runAckRequest(
    input: Omit<VoiceStateUpdateMessageInput, 'nonce'>,
    reliableKey: string,
  ) {
    return this.runtime.runPromise(this.runAckRequestEffect(input, reliableKey))
  }

  private runAckRequestEffect(
    input: Omit<VoiceStateUpdateMessageInput, 'nonce'>,
    reliableKey: string,
  ) {
    return Effect.gen({ self: this }, function* () {
      yield* this.ensureAvailable()
      const nonce = this.createNonce()
      return yield* this.waitForAck(nonce, input, reliableKey).pipe(
        Effect.timeoutOrElse({
          duration: this.requestTimeoutMs,
          orElse: () =>
            Effect.fail(
              authorityError(
                'voice_authority_timeout',
                'Voice authority request timed out',
                true,
              ),
            ),
        }),
      )
    })
  }

  private waitForAck(
    nonce: string,
    input: Omit<VoiceStateUpdateMessageInput, 'nonce'>,
    reliableKey: string,
  ) {
    return Effect.callback<void, VoiceAuthorityOperationError>((resume) => {
      if (this.disposed) {
        resume(Effect.fail(stateError('Voice authority adapter is disposed')))
        return
      }

      const pending: PendingAck = { resume }
      this.pendingAcks.set(nonce, pending)
      try {
        this.options.transport.sendReliable(
          voiceStateUpdateMessage({ ...input, nonce }),
          reliableKey,
        )
      } catch (cause) {
        this.pendingAcks.delete(nonce)
        resume(
          Effect.fail(
            new VoiceAuthorityMetadataError({
              message: 'Failed to send voice authority request',
              cause,
            }),
          ),
        )
      }

      return Effect.sync(() => {
        if (this.pendingAcks.get(nonce) === pending) {
          this.pendingAcks.delete(nonce)
        }
      })
    })
  }

  private handleEvent(input: Record<string, unknown>) {
    const decoded = Schema.decodeUnknownOption(GatewayEventSchema)(input)
    if (Option.isNone(decoded)) return
    const event = decoded.value

    switch (event.type) {
      case 'Bulk':
        for (const item of event.v) {
          if (isRecord(item)) this.handleEvent(item)
        }
        return
      case 'VoiceServerUpdate':
        this.handleServerUpdate(event)
        return
      case 'VoiceAuthoritySnapshot': {
        const snapshot = parseAuthoritySnapshot(event)
        if (snapshot) this.emit({ type: 'snapshot', snapshot })
        return
      }
      case 'VoiceAuthorityMove':
        this.emit({
          type: 'forcedMove',
          from: parseVoiceMembership(event.from),
          lease: parseVoiceLease(event.lease),
        })
        return
      case 'Ready': {
        if (!event.voice_authority) return
        const snapshot = parseAuthoritySnapshot(event.voice_authority)
        if (snapshot) this.emit({ type: 'snapshot', snapshot })
        return
      }
      case 'VoiceStateAck':
        this.finishAck(
          event.nonce,
          event.ok
            ? Effect.void
            : Effect.fail(
                authorityError(
                  'voice_authority_rejected',
                  'Voice authority rejected the request',
                  false,
                ),
              ),
        )
        return
      case 'Error':
        this.handleError(event)
    }
  }

  private handleServerUpdate(
    event: Extract<GatewayEvent, { type: 'VoiceServerUpdate' }>,
  ) {
    const pending = this.pendingLeases.get(event.operation_id)
    if (!pending) return

    const lease = parseVoiceLease(event)
    if (!leaseMatchesRequest(lease, pending.request)) {
      pending.resume(
        Effect.fail(
          authorityError(
            'voice_lease_mismatch',
            'Voice authority returned a mismatched RTC lease',
            false,
          ),
        ),
      )
      return
    }
    pending.resume(Effect.succeed(lease))
  }

  private handleError(event: Extract<GatewayEvent, { type: 'Error' }>) {
    const error = authorityError(
      'voice_authority_rejected',
      event.data?.message ?? 'Voice authority rejected the request',
      false,
    )
    const nonce = event.request?.nonce
    if (nonce) this.finishAck(nonce, Effect.fail(error))

    const operationId = event.request?.operation_id
    if (operationId) {
      this.pendingLeases.get(operationId)?.resume(Effect.fail(error))
    }
  }

  private finishAck(
    nonce: string,
    result: Effect.Effect<void, VoiceAuthorityOperationError>,
  ) {
    this.pendingAcks.get(nonce)?.resume(result)
  }

  private releasePendingClaim(request: VoiceReservationRequest) {
    const nonce = this.createNonce()
    this.options.transport.sendReliable(
      voiceStateUpdateMessage({
        nonce,
        request: authorityClaim('disconnect', request),
        channelId: null,
        userMuted: false,
        userDeafened: false,
        suppressCallNotifications: true,
      }),
      `voice-operation:${request.operationId}`,
    )
  }

  private createNonce() {
    const uuid = globalThis.crypto?.randomUUID?.()
    if (uuid) return uuid
    this.nonceCounter += 1
    return `voice-${Date.now().toString(36)}-${this.nonceCounter.toString(36)}`
  }

  private emit(event: VoiceAuthorityEvent) {
    for (const listener of this.listeners) listener(event)
  }
}

type AuthorityClaimSource = Readonly<{
  rtcEngine: VoiceRtcEngine
  clientInstanceId: string
  operationId: string
  connectionEpoch: string
}>

function authorityClaim(
  mode: 'join' | 'disconnect' | 'update_flags',
  input: AuthorityClaimSource,
) {
  return {
    mode,
    operation_id: input.operationId,
    rtc_engine: input.rtcEngine,
    client_instance_id: input.clientInstanceId,
    connection_epoch: input.connectionEpoch,
  }
}

type VoiceStateUpdateMessageInput = {
  nonce: string
  request: Record<string, unknown>
  channelId: string | null
  userMuted: boolean
  userDeafened: boolean
  node?: string
  recipients?: readonly string[]
  suppressCallNotifications?: boolean
}

function voiceStateUpdateMessage(input: VoiceStateUpdateMessageInput) {
  return {
    type: 'VoiceStateUpdate',
    nonce: input.nonce,
    request: input.request,
    channel_id: input.channelId,
    self_mute: input.userMuted,
    self_deaf: input.userDeafened,
    ...(input.node ? { node: input.node } : {}),
    ...(input.recipients?.length ? { recipients: [...input.recipients] } : {}),
    ...(input.suppressCallNotifications
      ? { suppress_call_notifications: true }
      : {}),
  }
}

function parseVoiceLease(event: typeof VoiceLeaseSchema.Type): VoiceLease {
  return {
    channelId: event.channel_id,
    rtcEngine: event.credential.rtc_engine,
    clientInstanceId: event.credential.client_instance_id,
    operationId: event.operation_id,
    connectionEpoch: event.credential.connection_epoch,
    authorityVersion: event.authority_version,
    credential: {
      url: event.url,
      token: event.credential.token,
      participantIdentity: event.credential.identity,
    },
  }
}

function parseAuthoritySnapshot(
  event: AuthoritySnapshotPayload,
): AuthoritativeVoiceSnapshot | null {
  const membershipFields = [
    event.operation_id,
    event.channel_id,
    event.rtc_engine,
    event.client_instance_id,
    event.connection_epoch,
  ]
  const hasAnyMembership = membershipFields.some((value) => value != null)
  const hasCompleteMembership =
    event.operation_id != null &&
    event.channel_id != null &&
    event.rtc_engine != null &&
    event.client_instance_id != null &&
    event.connection_epoch != null

  if (hasAnyMembership && !hasCompleteMembership) return null

  let membership: VoiceMembership | null = null
  if (hasCompleteMembership) {
    membership = {
      operationId: event.operation_id,
      channelId: event.channel_id,
      rtcEngine: event.rtc_engine,
      clientInstanceId: event.client_instance_id,
      connectionEpoch: event.connection_epoch,
    }
  }

  return {
    authorityVersion: event.version,
    complete: true,
    membership,
    serverMuted: event.state?.server_muted === true,
    serverDeafened: event.state?.server_deafened === true,
  }
}

function parseVoiceMembership(
  event: typeof VoiceMembershipSchema.Type,
): VoiceMembership {
  return {
    channelId: event.channel_id,
    rtcEngine: event.rtc_engine,
    clientInstanceId: event.client_instance_id,
    operationId: event.operation_id,
    connectionEpoch: event.connection_epoch,
  }
}

function leaseMatchesRequest(
  lease: VoiceLease,
  request: VoiceReservationRequest,
) {
  return (
    lease.channelId === request.channelId &&
    lease.rtcEngine === request.rtcEngine &&
    lease.clientInstanceId === request.clientInstanceId &&
    lease.operationId === request.operationId &&
    lease.connectionEpoch === request.connectionEpoch
  )
}

function isAllowedVoiceUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'wss:' || url.protocol === 'ws:'
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function authorityError(code: string, message: string, retryable: boolean) {
  return new VoiceAuthorityRequestError({
    message,
    failure: { code, message, retryable, stage: 'voice_authority' },
  })
}

function stateError(message: string) {
  return new VoiceAuthorityStateError({ message })
}

function abortSignal(signal: AbortSignal) {
  return Effect.callback<never, DOMException>((resume) => {
    if (signal.aborted) {
      resume(Effect.fail(abortError()))
      return
    }
    const onAbort = () => resume(Effect.fail(abortError()))
    signal.addEventListener('abort', onAbort, { once: true })
    return Effect.sync(() => signal.removeEventListener('abort', onAbort))
  })
}

function abortError() {
  return new DOMException('Voice authority operation superseded', 'AbortError')
}
