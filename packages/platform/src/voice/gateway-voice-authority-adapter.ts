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
  VoiceRtcEngine,
} from './voice-types'

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

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

type PendingLease = {
  request: VoiceReservationRequest
  resolve: (lease: VoiceLease) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  signal: AbortSignal
  onAbort: () => void
}

type PendingAck = {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Shared, strict voice-authority protocol used by web and Electron main. */
export class GatewayVoiceAuthorityAdapter implements VoiceAuthorityAdapter {
  private readonly listeners = new Set<(event: VoiceAuthorityEvent) => void>()
  private readonly pendingLeases = new Map<string, PendingLease>()
  private readonly pendingAcks = new Map<string, PendingAck>()
  private readonly requestTimeoutMs: number
  private readonly unsubscribeEvents: () => void
  private readonly unsubscribeState: () => void
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
      if (state === 'connected') void this.requestSnapshot().catch(() => undefined)
    })
  }

  async reserve(request: VoiceReservationRequest, signal: AbortSignal) {
    if (this.disposed) throw new Error('Voice authority adapter is disposed')
    if (signal.aborted) throw abortError()
    if (this.pendingLeases.has(request.operationId)) {
      throw new Error('Duplicate voice operation id')
    }

    const metadata = await this.options.resolveJoinMetadata?.(request)
    if (signal.aborted) throw abortError()

    return new Promise<VoiceLease>((resolve, reject) => {
      const onAbort = () => {
        this.releasePendingClaim(request)
        this.finishLease(request.operationId, abortError())
      }
      const timer = setTimeout(() => {
        this.releasePendingClaim(request)
        this.finishLease(
          request.operationId,
          authorityError(
            'voice_authority_timeout',
            'Voice authority did not return an RTC lease',
            true,
          ),
        )
      }, this.requestTimeoutMs)
      this.pendingLeases.set(request.operationId, {
        request,
        resolve,
        reject,
        timer,
        signal,
        onAbort,
      })
      signal.addEventListener('abort', onAbort, { once: true })

      const nonce = this.createNonce()
      this.options.transport.sendReliable(
        voiceStateUpdateMessage({
          nonce,
          request: authorityClaim('join', request),
          channelId: request.channelId,
          // Self-deafen also publishes self-mute. The desired state keeps
          // the user's mute preference separately so it can be restored when
          // deafen is cleared.
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
    })
  }

  cancel(input: VoiceCancellation) {
    return this.sendAckRequest(
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
    return this.sendAckRequest(
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
    return this.sendAckRequest(
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
    for (const operationId of [...this.pendingLeases.keys()]) {
      const pending = this.pendingLeases.get(operationId)
      if (pending) this.releasePendingClaim(pending.request)
      this.finishLease(operationId, new Error('Voice authority adapter disposed'))
    }
    for (const [nonce, pending] of this.pendingAcks) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Voice authority adapter disposed'))
      this.pendingAcks.delete(nonce)
    }
    this.listeners.clear()
  }

  private sendAckRequest(
    input: Omit<VoiceStateUpdateMessageInput, 'nonce'>,
    reliableKey: string,
  ) {
    if (this.disposed) {
      return Promise.reject(new Error('Voice authority adapter is disposed'))
    }
    const nonce = this.createNonce()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(nonce)
        reject(
          authorityError(
            'voice_authority_timeout',
            'Voice authority request timed out',
            true,
          ),
        )
      }, this.requestTimeoutMs)
      this.pendingAcks.set(nonce, { resolve, reject, timer })
      this.options.transport.sendReliable(
        voiceStateUpdateMessage({ ...input, nonce }),
        reliableKey,
      )
    })
  }

  private handleEvent(event: Record<string, unknown>) {
    if (event.type === 'VoiceServerUpdate') {
      this.handleServerUpdate(event)
      return
    }
    if (event.type === 'VoiceAuthoritySnapshot') {
      const snapshot = parseAuthoritySnapshot(event)
      if (snapshot) this.emit({ type: 'snapshot', snapshot })
      return
    }
    if (event.type === 'VoiceAuthorityMove') {
      const move = parseAuthorityMove(event)
      if (move) this.emit({ type: 'forcedMove', ...move })
      return
    }
    if (event.type === 'Ready') {
      const embedded = event.voice_authority
      if (isRecord(embedded)) {
        const snapshot = parseAuthoritySnapshot(embedded)
        if (snapshot) this.emit({ type: 'snapshot', snapshot })
      }
      return
    }
    if (event.type === 'VoiceStateAck') {
      const nonce = stringField(event, 'nonce')
      if (!nonce) return
      const pending = this.pendingAcks.get(nonce)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pendingAcks.delete(nonce)
      if (event.ok === true) pending.resolve()
      else pending.reject(authorityError('voice_authority_rejected', 'Voice authority rejected the request', false))
      return
    }
    if (event.type === 'Error') this.handleError(event)
  }

  private handleServerUpdate(event: Record<string, unknown>) {
    const operationId = stringField(event, 'operation_id')
    if (!operationId) return
    const pending = this.pendingLeases.get(operationId)
    if (!pending) return
    const lease = parseVoiceLease(event)
    if (!lease || !leaseMatchesRequest(lease, pending.request)) {
      this.releasePendingClaim(pending.request)
      this.finishLease(
        operationId,
        authorityError(
          'voice_lease_mismatch',
          'Voice authority returned a mismatched RTC lease',
          false,
        ),
      )
      return
    }
    this.finishLease(operationId, lease)
  }

  private handleError(event: Record<string, unknown>) {
    const request = isRecord(event.request) ? event.request : null
    const nonce = request ? stringField(request, 'nonce') : undefined
    if (nonce) {
      const pendingAck = this.pendingAcks.get(nonce)
      if (pendingAck) {
        clearTimeout(pendingAck.timer)
        this.pendingAcks.delete(nonce)
        pendingAck.reject(
          authorityError(
            'voice_authority_rejected',
            errorMessage(event),
            false,
          ),
        )
      }
    }
    const operationId = request
      ? stringField(request, 'operation_id')
      : undefined
    if (operationId && this.pendingLeases.has(operationId)) {
      const pending = this.pendingLeases.get(operationId)
      if (pending) this.releasePendingClaim(pending.request)
      this.finishLease(
        operationId,
        authorityError(
          'voice_authority_rejected',
          errorMessage(event),
          false,
        ),
      )
    }
  }

  private finishLease(operationId: string, result: VoiceLease | Error) {
    const pending = this.pendingLeases.get(operationId)
    if (!pending) return
    clearTimeout(pending.timer)
    pending.signal.removeEventListener('abort', pending.onAbort)
    this.pendingLeases.delete(operationId)
    if (result instanceof Error) pending.reject(result)
    else pending.resolve(result)
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

function authorityClaim(mode: 'join' | 'disconnect' | 'update_flags', input: AuthorityClaimSource) {
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

function parseVoiceLease(event: Record<string, unknown>): VoiceLease | null {
  const credential = isRecord(event.credential) ? event.credential : null
  const rtcEngine = credential
    ? parseRtcEngine(credential.rtc_engine)
    : null
  const channelId = stringField(event, 'channel_id')
  const operationId = stringField(event, 'operation_id')
  const clientInstanceId = credential
    ? stringField(credential, 'client_instance_id')
    : undefined
  const connectionEpoch = credential
    ? stringField(credential, 'connection_epoch')
    : undefined
  const url = stringField(event, 'url', 2_048)
  const token = credential ? stringField(credential, 'token', 32_768) : undefined
  const participantIdentity = credential
    ? stringField(credential, 'identity', 2_048)
    : undefined
  const authorityVersion = finiteInteger(event.authority_version)
  if (
    !rtcEngine ||
    !channelId ||
    !operationId ||
    !clientInstanceId ||
    !connectionEpoch ||
    !url ||
    !isAllowedVoiceUrl(url) ||
    !token ||
    !participantIdentity ||
    authorityVersion === null
  ) {
    return null
  }
  return {
    channelId,
    rtcEngine,
    clientInstanceId,
    operationId,
    connectionEpoch,
    authorityVersion,
    credential: { url, token, participantIdentity },
  }
}

function parseAuthoritySnapshot(
  event: Record<string, unknown>,
): AuthoritativeVoiceSnapshot | null {
  const authorityVersion = finiteInteger(event.version)
  if (authorityVersion === null) return null
  const rawFields = [
    event.operation_id,
    event.channel_id,
    event.rtc_engine,
    event.client_instance_id,
    event.connection_epoch,
  ]
  const hasMembership = rawFields.every(
    (value) => typeof value === 'string' && value.length > 0 && value.length <= 512,
  )
  if (!hasMembership && rawFields.some((value) => value != null)) return null
  const rtcEngine = hasMembership ? parseRtcEngine(event.rtc_engine) : null
  if (hasMembership && !rtcEngine) return null
  const state = isRecord(event.state) ? event.state : null
  return {
    authorityVersion,
    complete: true,
    membership: hasMembership
      ? {
          operationId: event.operation_id as string,
          channelId: event.channel_id as string,
          rtcEngine: rtcEngine!,
          clientInstanceId: event.client_instance_id as string,
          connectionEpoch: event.connection_epoch as string,
        }
      : null,
    serverMuted: state?.server_muted === true,
    serverDeafened: state?.server_deafened === true,
  }
}

function parseAuthorityMove(event: Record<string, unknown>) {
  const fromValue = isRecord(event.from) ? event.from : null
  const leaseValue = isRecord(event.lease) ? event.lease : null
  if (!fromValue || !leaseValue) return null
  const from = parseVoiceMembership(fromValue)
  const lease = parseVoiceLease(leaseValue)
  if (!from || !lease) return null
  return { from, lease }
}

function parseVoiceMembership(event: Record<string, unknown>) {
  const rtcEngine = parseRtcEngine(event.rtc_engine)
  const channelId = stringField(event, 'channel_id')
  const operationId = stringField(event, 'operation_id')
  const clientInstanceId = stringField(event, 'client_instance_id')
  const connectionEpoch = stringField(event, 'connection_epoch')
  if (
    !rtcEngine ||
    !channelId ||
    !operationId ||
    !clientInstanceId ||
    !connectionEpoch
  ) {
    return null
  }
  return {
    channelId,
    rtcEngine,
    clientInstanceId,
    operationId,
    connectionEpoch,
  }
}

function leaseMatchesRequest(lease: VoiceLease, request: VoiceReservationRequest) {
  return (
    lease.channelId === request.channelId &&
    lease.rtcEngine === request.rtcEngine &&
    lease.clientInstanceId === request.clientInstanceId &&
    lease.operationId === request.operationId &&
    lease.connectionEpoch === request.connectionEpoch
  )
}

function parseRtcEngine(value: unknown): VoiceRtcEngine | null {
  return value === 'web' || value === 'windows_native' ? value : null
}

function finiteInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null
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

function stringField(record: Record<string, unknown>, key: string, maxLength = 512) {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    ? value
    : undefined
}

function errorMessage(event: Record<string, unknown>) {
  const data = isRecord(event.data) ? event.data : null
  return data && typeof data.message === 'string'
    ? data.message
    : 'Voice authority rejected the request'
}

function authorityError(code: string, message: string, retryable: boolean) {
  return Object.assign(new Error(message), {
    failure: { code, message, retryable, stage: 'voice_authority' },
  })
}

function abortError() {
  return new DOMException('Voice authority operation superseded', 'AbortError')
}
