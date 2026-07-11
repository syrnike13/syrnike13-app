import type { Room } from 'livekit-client'
import {
  isVoiceCommand,
  isVoiceSnapshot,
  type VoiceCommand,
  type VoiceSnapshot,
} from '@syrnike13/platform'

export interface OwnedBrowserVoiceClient {
  dispatch(command: VoiceCommand): void
  snapshot(): VoiceSnapshot
  subscribe(listener: (snapshot: VoiceSnapshot) => void): () => void
  room(): Room | null
  subscribeRoom(listener: (room: Room | null) => void): () => void
  subscribeSpeaking(
    listener: (userIds: ReadonlySet<string>) => void,
  ): () => void
  dispose(): Promise<void> | void
}

type VoiceOwnerChannel = {
  postMessage(message: VoiceOwnerMessage): void
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void
  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void
  close(): void
}

export type VoiceTabOwnerDependencies = Readonly<{
  createChannel?: (name: string) => VoiceOwnerChannel
  holdExclusiveLock?: (
    name: string,
    whileHeld: () => Promise<void>,
  ) => Promise<void>
  createTabId?: () => string
}>

type VoiceOwnerMessage =
  | Readonly<{
      type: 'observe'
      requesterId: string
    }>
  | Readonly<{
      type: 'takeover'
      requesterId: string
    }>
  | Readonly<{
      type: 'owner'
      ownerId: string
      ownerEpoch: string
    }>
  | Readonly<{
      type: 'released'
      ownerId: string
      ownerEpoch: string
    }>
  | Readonly<{
      type: 'command'
      requesterId: string
      command: Exclude<VoiceCommand, { type: 'join' }>
    }>
  | Readonly<{
      type: 'snapshot'
      ownerId: string
      ownerEpoch: string
      sequence: number
      snapshot: VoiceSnapshot
    }>

/**
 * Holds the one browser Voice Director/Room behind a cross-tab exclusive lock.
 * Observer tabs receive snapshots and may forward controls, but they never run
 * RTC recovery. A join in another tab is an explicit ownership takeover.
 */
export class VoiceTabOwner implements OwnedBrowserVoiceClient {
  private readonly tabId: string
  private readonly channel: VoiceOwnerChannel | null
  private readonly holdExclusiveLock: VoiceTabOwnerDependencies['holdExclusiveLock']
  private readonly snapshotListeners = new Set<
    (snapshot: VoiceSnapshot) => void
  >()
  private readonly roomListeners = new Set<(room: Room | null) => void>()
  private readonly speakingListeners = new Set<
    (userIds: ReadonlySet<string>) => void
  >()
  private ownedClient: OwnedBrowserVoiceClient | null = null
  private ownerId: string | null = null
  private ownerEpoch: string | null = null
  private ownerSequence = 0
  private observedSequence = -1
  private pendingJoin: Extract<VoiceCommand, { type: 'join' }> | null = null
  private readonly retainedCommands = new Map<
    RetainedCommand['type'],
    RetainedCommand
  >()
  private acquirePromise: Promise<void> | null = null
  private releaseLock: (() => void) | null = null
  private ownerUnsubscribers: Array<() => void> = []
  private snapshotValue: VoiceSnapshot
  private roomValue: Room | null = null
  private disposed = false

  constructor(
    private readonly userId: string,
    initialSnapshot: VoiceSnapshot,
    private readonly createOwnedClient: () => OwnedBrowserVoiceClient,
    dependencies: VoiceTabOwnerDependencies = {},
  ) {
    this.snapshotValue = initialSnapshot
    this.tabId = dependencies.createTabId?.() ?? crypto.randomUUID()
    this.holdExclusiveLock =
      dependencies.holdExclusiveLock ?? browserExclusiveLock
    const createChannel =
      dependencies.createChannel ??
      ((name: string) => new BroadcastChannel(name) as VoiceOwnerChannel)
    try {
      this.channel = createChannel(`syrnike-voice-owner:v1:${userId}`)
      this.channel.addEventListener('message', this.handleMessage)
      this.channel.postMessage({ type: 'observe', requesterId: this.tabId })
    } catch {
      this.channel = null
    }
  }

  dispatch(command: VoiceCommand) {
    if (this.disposed) return
    if (command.type === 'join') {
      this.pendingJoin = command
      if (this.ownedClient) {
        this.pendingJoin = null
        this.ownedClient.dispatch(command)
      } else {
        void this.acquireOwnership()
      }
      return
    }

    if (isRetainedCommand(command)) {
      this.retainedCommands.set(command.type, command)
    }

    if (this.ownedClient) {
      this.ownedClient.dispatch(command)
      if (command.type === 'leave') void this.relinquishOwnership()
      return
    }

    if (!this.channel || !this.ownerId) {
      if (command.type === 'leave') {
        this.pendingJoin = null
        this.publishLocalSnapshot(disconnectedSnapshot(this.snapshotValue))
      }
      return
    }
    this.channel.postMessage({
      type: 'command',
      requesterId: this.tabId,
      command,
    })
  }

  snapshot() {
    return this.snapshotValue
  }

  subscribe(listener: (snapshot: VoiceSnapshot) => void) {
    this.snapshotListeners.add(listener)
    listener(this.snapshotValue)
    return () => this.snapshotListeners.delete(listener)
  }

  room() {
    return this.roomValue
  }

  subscribeRoom(listener: (room: Room | null) => void) {
    this.roomListeners.add(listener)
    listener(this.roomValue)
    return () => this.roomListeners.delete(listener)
  }

  subscribeSpeaking(listener: (userIds: ReadonlySet<string>) => void) {
    this.speakingListeners.add(listener)
    listener(new Set(this.snapshotValue.speakingUserIds))
    return () => this.speakingListeners.delete(listener)
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    this.channel?.removeEventListener('message', this.handleMessage)
    await this.relinquishOwnership()
    this.channel?.close()
    this.snapshotListeners.clear()
    this.roomListeners.clear()
    this.speakingListeners.clear()
  }

  private async acquireOwnership() {
    if (this.acquirePromise || this.disposed || !this.pendingJoin) return
    if (!this.channel || !this.holdExclusiveLock) {
      this.publishLocalSnapshot({
        ...this.snapshotValue,
        intentChannelId: this.pendingJoin.channelId,
        membershipChannelId: null,
        connection: 'failed',
        failure: {
          code: 'voice_tab_coordination_unavailable',
          message: 'This browser cannot safely coordinate voice between tabs',
          retryable: false,
          stage: 'tab_owner',
        },
      })
      return
    }

    this.channel.postMessage({ type: 'takeover', requesterId: this.tabId })
    const lockName = `syrnike-voice-owner:v1:${this.userId}`
    this.acquirePromise = this.holdExclusiveLock(lockName, async () => {
      if (this.disposed || !this.pendingJoin) return
      const ownerEpoch = crypto.randomUUID()
      this.ownerId = this.tabId
      this.ownerEpoch = ownerEpoch
      this.ownerSequence = 0
      this.observedSequence = -1
      this.channel?.postMessage({
        type: 'owner',
        ownerId: this.tabId,
        ownerEpoch,
      })

      const client = this.createOwnedClient()
      this.ownedClient = client
      this.attachOwnedClient(client)
      for (const command of this.retainedCommands.values()) {
        client.dispatch(command)
      }
      const join = this.pendingJoin
      this.pendingJoin = null
      client.dispatch(join)

      await new Promise<void>((resolve) => {
        this.releaseLock = resolve
      })
    })
      .catch(() => {
        if (this.disposed || !this.pendingJoin) return
        const failedJoin = this.pendingJoin
        this.pendingJoin = null
        this.publishLocalSnapshot({
          ...this.snapshotValue,
          intentChannelId: failedJoin.channelId,
          membershipChannelId: null,
          connection: 'failed',
          failure: {
            code: 'voice_tab_lock_failed',
            message: 'Could not acquire exclusive ownership of browser voice',
            retryable: true,
            stage: 'tab_owner',
          },
        })
      })
      .finally(() => {
        this.acquirePromise = null
        this.releaseLock = null
        if (!this.disposed && this.pendingJoin && !this.ownedClient) {
          void this.acquireOwnership()
        }
      })
    await this.acquirePromise
  }

  private attachOwnedClient(client: OwnedBrowserVoiceClient) {
    this.detachOwnedClient()
    this.ownerUnsubscribers = [
      client.subscribe((snapshot) => {
        if (this.ownedClient !== client) return
        this.publishLocalSnapshot(snapshot)
        if (!this.ownerEpoch) return
        this.channel?.postMessage({
          type: 'snapshot',
          ownerId: this.tabId,
          ownerEpoch: this.ownerEpoch,
          sequence: ++this.ownerSequence,
          snapshot,
        })
      }),
      client.subscribeRoom((room) => {
        if (this.ownedClient !== client) return
        this.roomValue = room
        for (const listener of this.roomListeners) listener(room)
      }),
      client.subscribeSpeaking((userIds) => {
        if (this.ownedClient !== client) return
        for (const listener of this.speakingListeners) listener(userIds)
      }),
    ]
  }

  private detachOwnedClient() {
    for (const unsubscribe of this.ownerUnsubscribers) unsubscribe()
    this.ownerUnsubscribers = []
    this.roomValue = null
    for (const listener of this.roomListeners) listener(null)
  }

  private async relinquishOwnership() {
    const client = this.ownedClient
    const ownerEpoch = this.ownerEpoch
    this.ownedClient = null
    this.detachOwnedClient()
    if (client) await client.dispose()
    if (ownerEpoch) {
      const disconnected = disconnectedSnapshot(this.snapshotValue)
      this.publishLocalSnapshot(disconnected)
      this.channel?.postMessage({
        type: 'snapshot',
        ownerId: this.tabId,
        ownerEpoch,
        sequence: ++this.ownerSequence,
        snapshot: disconnected,
      })
      this.channel?.postMessage({
        type: 'released',
        ownerId: this.tabId,
        ownerEpoch,
      })
    }
    this.ownerId = null
    this.ownerEpoch = null
    this.releaseLock?.()
  }

  private readonly handleMessage = (event: MessageEvent<unknown>) => {
    const message = parseOwnerMessage(event.data)
    if (!message || this.disposed) return
    switch (message.type) {
      case 'observe':
        if (
          message.requesterId !== this.tabId &&
          this.ownedClient &&
          this.ownerEpoch
        ) {
          this.channel?.postMessage({
            type: 'owner',
            ownerId: this.tabId,
            ownerEpoch: this.ownerEpoch,
          })
          this.channel?.postMessage({
            type: 'snapshot',
            ownerId: this.tabId,
            ownerEpoch: this.ownerEpoch,
            sequence: ++this.ownerSequence,
            snapshot: this.snapshotValue,
          })
        }
        return
      case 'takeover':
        if (message.requesterId !== this.tabId && this.ownedClient) {
          void this.relinquishOwnership()
        }
        return
      case 'owner':
        this.ownerId = message.ownerId
        this.ownerEpoch = message.ownerEpoch
        this.observedSequence = -1
        if (this.pendingJoin && message.ownerId !== this.tabId) {
          this.channel?.postMessage({
            type: 'takeover',
            requesterId: this.tabId,
          })
        }
        return
      case 'released':
        if (
          this.ownerId === message.ownerId &&
          this.ownerEpoch === message.ownerEpoch
        ) {
          this.ownerId = null
          this.ownerEpoch = null
        }
        return
      case 'command':
        if (!this.ownedClient || message.requesterId === this.tabId) return
        this.ownedClient.dispatch(message.command)
        if (message.command.type === 'leave') void this.relinquishOwnership()
        return
      case 'snapshot':
        if (message.ownerId === this.tabId || this.ownedClient) return
        if (
          this.ownerId !== message.ownerId ||
          this.ownerEpoch !== message.ownerEpoch ||
          message.sequence <= this.observedSequence
        ) {
          return
        }
        this.observedSequence = message.sequence
        this.publishLocalSnapshot(message.snapshot)
    }
  }

  private publishLocalSnapshot(snapshot: VoiceSnapshot) {
    this.snapshotValue = snapshot
    for (const listener of this.snapshotListeners) listener(snapshot)
    const speaking = new Set(snapshot.speakingUserIds)
    for (const listener of this.speakingListeners) listener(speaking)
  }
}

type RetainedCommand = Exclude<
  VoiceCommand,
  | { type: 'join' }
  | { type: 'leave' }
  | { type: 'retryVoice' }
  | { type: 'retryMedia' }
>

function isRetainedCommand(command: VoiceCommand): command is RetainedCommand {
  return (
    command.type !== 'join' &&
    command.type !== 'leave' &&
    command.type !== 'retryVoice' &&
    command.type !== 'retryMedia'
  )
}

function browserExclusiveLock(
  name: string,
  whileHeld: () => Promise<void>,
) {
  if (!navigator.locks) {
    return Promise.reject(new Error('Web Locks are unavailable'))
  }
  return navigator.locks.request(name, () => whileHeld())
}

function parseOwnerMessage(value: unknown): VoiceOwnerMessage | null {
  if (!value || typeof value !== 'object') return null
  const message = value as Partial<VoiceOwnerMessage>
  if (message.type === 'observe' || message.type === 'takeover') {
    return validId(message.requesterId) ? (message as VoiceOwnerMessage) : null
  }
  if (message.type === 'owner' || message.type === 'released') {
    return validId(message.ownerId) && validId(message.ownerEpoch)
      ? (message as VoiceOwnerMessage)
      : null
  }
  if (message.type === 'snapshot') {
    return validId(message.ownerId) &&
      validId(message.ownerEpoch) &&
      Number.isSafeInteger(message.sequence) &&
      Number(message.sequence) >= 0 &&
      isVoiceSnapshot(message.snapshot)
      ? (message as VoiceOwnerMessage)
      : null
  }
  if (message.type === 'command') {
    const command = (value as { command?: unknown }).command
    return validId(message.requesterId) &&
      isVoiceCommand(command) &&
      command.type !== 'join'
      ? (message as VoiceOwnerMessage)
      : null
  }
  return null
}

function disconnectedSnapshot(snapshot: VoiceSnapshot): VoiceSnapshot {
  return {
    ...snapshot,
    intentChannelId: null,
    membershipChannelId: null,
    connection: 'disconnected',
    operationId: undefined,
    connectionEpoch: undefined,
    retryAttempt: undefined,
    failure: undefined,
    microphone: { state: 'off' },
    output: { state: 'off' },
    camera: { state: 'off' },
    screen: { state: 'off' },
    screenAudio: { state: 'off' },
    speakingUserIds: [],
  }
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}
