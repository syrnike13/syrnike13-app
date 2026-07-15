import { describe, expect, it } from 'vitest'
import type { Room } from 'livekit-client'
import type { VoiceCommand, VoiceSnapshot } from '@syrnike13/platform'

import {
  VoiceTabOwner,
  type OwnedBrowserVoiceClient,
} from './voice-tab-owner'

class ChannelHub {
  private readonly channels = new Map<string, Set<FakeChannel>>()

  create = (name: string) => {
    const channel = new FakeChannel(name, this)
    const channels = this.channels.get(name) ?? new Set()
    channels.add(channel)
    this.channels.set(name, channels)
    return channel
  }

  send(sender: FakeChannel, message: unknown) {
    for (const channel of this.channels.get(sender.name) ?? []) {
      if (channel !== sender) channel.deliver(message)
    }
  }

  remove(channel: FakeChannel) {
    this.channels.get(channel.name)?.delete(channel)
  }
}

class FakeChannel {
  readonly listeners = new Set<(event: MessageEvent<unknown>) => void>()

  constructor(
    readonly name: string,
    private readonly hub: ChannelHub,
  ) {}

  postMessage(message: unknown) {
    this.hub.send(this, message)
  }

  addEventListener(
    _type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ) {
    this.listeners.add(listener)
  }

  removeEventListener(
    _type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ) {
    this.listeners.delete(listener)
  }

  close() {
    this.hub.remove(this)
    this.listeners.clear()
  }

  deliver(data: unknown) {
    for (const listener of this.listeners) {
      listener({ data } as MessageEvent<unknown>)
    }
  }
}

class ExclusiveLocks {
  private readonly tails = new Map<string, Promise<void>>()

  hold = async (name: string, whileHeld: () => Promise<void>) => {
    const previous = this.tails.get(name) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(whileHeld)
    this.tails.set(name, current)
    await current
  }
}

class FakeOwnedClient implements OwnedBrowserVoiceClient {
  readonly commands: VoiceCommand[] = []
  readonly listeners = new Set<(snapshot: VoiceSnapshot) => void>()
  value = initialSnapshot()
  disposed = false

  dispatch(command: VoiceCommand) {
    this.commands.push(command)
    if (command.type === 'join') {
      this.value = {
        ...this.value,
        intentChannelId: command.channelId,
        membershipChannelId: command.channelId,
        connection: 'connected',
        operationId: `op-${command.channelId}`,
        connectionEpoch: `epoch-${command.channelId}`,
      }
    } else if (command.type === 'setUserMuted') {
      this.value = {
        ...this.value,
        userMuted: command.muted,
        effectiveMuted: command.muted,
      }
    } else if (command.type === 'leave') {
      this.value = initialSnapshot()
    }
    for (const listener of this.listeners) listener(this.value)
  }

  snapshot() {
    return this.value
  }

  subscribe(listener: (snapshot: VoiceSnapshot) => void) {
    this.listeners.add(listener)
    listener(this.value)
    return () => this.listeners.delete(listener)
  }

  room() {
    return null
  }

  subscribeRoom(listener: (room: Room | null) => void) {
    listener(null)
    return () => undefined
  }

  async dispose() {
    this.disposed = true
    this.listeners.clear()
  }
}

function harness(snapshot: VoiceSnapshot = initialSnapshot()) {
  const hub = new ChannelHub()
  const locks = new ExclusiveLocks()
  let nextTab = 0
  const clients: FakeOwnedClient[] = []
  const createOwner = () =>
    new VoiceTabOwner(
      'user-a',
      snapshot,
      () => {
        const client = new FakeOwnedClient()
        clients.push(client)
        return client
      },
      {
        createChannel: hub.create,
        holdExclusiveLock: locks.hold,
        createTabId: () => `tab-${++nextTab}`,
      },
    )
  return { clients, createOwner }
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition was not reached')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

describe('VoiceTabOwner', () => {
  it('projects retained self controls before the first join', async () => {
    const { createOwner } = harness()
    const owner = createOwner()
    const snapshots: VoiceSnapshot[] = []
    owner.subscribe((snapshot) => snapshots.push(snapshot))

    owner.dispatch({ type: 'setUserMuted', muted: false })
    expect(owner.snapshot()).toMatchObject({
      userMuted: false,
      userDeafened: false,
      effectiveMuted: false,
    })
    expect(snapshots.at(-1)).toBe(owner.snapshot())

    owner.dispatch({ type: 'setUserDeafened', deafened: true })
    expect(owner.snapshot()).toMatchObject({
      userMuted: false,
      userDeafened: true,
      effectiveMuted: true,
    })
    expect(snapshots).toHaveLength(3)

    owner.dispatch({ type: 'setUserDeafened', deafened: false })
    expect(owner.snapshot().effectiveMuted).toBe(false)

    await owner.dispose()
  })

  it.each([
    ['server mute', { serverMuted: true }],
    ['server deafen', { serverDeafened: true }],
    ['system privacy mute', { systemPrivacyMuted: true }],
    ['monitoring mute', { monitoringMuted: true }],
    [
      'released push-to-talk key',
      { inputMode: 'push_to_talk' as const, pushToTalkHeld: false },
    ],
  ])('preserves effective mute from %s before join', async (_name, state) => {
    const { createOwner } = harness({ ...initialSnapshot(), ...state })
    const owner = createOwner()

    owner.dispatch({ type: 'setUserMuted', muted: false })

    expect(owner.snapshot().effectiveMuted).toBe(true)
    await owner.dispose()
  })

  it('explicitly transfers the one browser RTC owner between tabs', async () => {
    const { clients, createOwner } = harness()
    const first = createOwner()
    const second = createOwner()

    first.dispatch({ type: 'join', channelId: 'A' })
    await waitUntil(() => clients.length === 1)
    expect(first.snapshot().membershipChannelId).toBe('A')
    await waitUntil(() => second.snapshot().membershipChannelId === 'A')

    second.dispatch({ type: 'join', channelId: 'B' })
    await waitUntil(() => clients.length === 2)
    expect(clients[0].disposed).toBe(true)
    expect(clients[1].commands).toContainEqual({ type: 'join', channelId: 'B' })
    expect(second.snapshot().membershipChannelId).toBe('B')
    await waitUntil(() => first.snapshot().membershipChannelId === 'B')

    await Promise.all([first.dispose(), second.dispose()])
  })

  it('applies retained media preferences before the first join', async () => {
    const { clients, createOwner } = harness()
    const owner = createOwner()

    owner.dispatch({ type: 'setUserMuted', muted: false })
    owner.dispatch({ type: 'setUserDeafened', deafened: true })
    owner.dispatch({
      type: 'configureOutput',
      deviceId: 'speakers',
      volume: 1.5,
    })
    owner.dispatch({ type: 'join', channelId: 'A' })

    await waitUntil(() => clients.length === 1)
    expect(clients[0].commands).toEqual([
      { type: 'setUserMuted', muted: false },
      { type: 'setUserDeafened', deafened: true },
      { type: 'configureOutput', deviceId: 'speakers', volume: 1.5 },
      { type: 'join', channelId: 'A' },
    ])

    await owner.dispose()
  })

  it('does not restore camera or screen sharing after leaving and rejoining', async () => {
    const { clients, createOwner } = harness()
    const owner = createOwner()

    owner.dispatch({ type: 'join', channelId: 'A' })
    await waitUntil(() => clients.length === 1)
    owner.dispatch({ type: 'setCamera', enabled: true, deviceId: 'camera-a' })
    owner.dispatch({
      type: 'setScreen',
      enabled: true,
      audioEnabled: true,
      width: 1_920,
      height: 1_080,
      fps: 60,
      bitrate: 6_000_000,
    })

    owner.dispatch({ type: 'leave' })
    await waitUntil(() => owner.snapshot().connection === 'disconnected')
    owner.dispatch({ type: 'join', channelId: 'B' })
    await waitUntil(() => clients.length === 2)

    expect(clients[1].commands).toEqual([{ type: 'join', channelId: 'B' }])
    await owner.dispose()
  })

  it('forwards controls from an observer without creating another Room', async () => {
    const { clients, createOwner } = harness()
    const owner = createOwner()
    const observer = createOwner()
    owner.dispatch({ type: 'join', channelId: 'A' })
    await waitUntil(() => observer.snapshot().membershipChannelId === 'A')

    observer.dispatch({ type: 'setUserMuted', muted: false })
    await waitUntil(() => owner.snapshot().userMuted === false)

    expect(clients).toHaveLength(1)
    expect(clients[0].commands).toContainEqual({
      type: 'setUserMuted',
      muted: false,
    })
    await Promise.all([owner.dispose(), observer.dispose()])
  })

  it('releases ownership and projects disconnected state on observer leave', async () => {
    const { clients, createOwner } = harness()
    const owner = createOwner()
    const observer = createOwner()
    owner.dispatch({ type: 'join', channelId: 'A' })
    await waitUntil(() => observer.snapshot().membershipChannelId === 'A')

    observer.dispatch({ type: 'leave' })
    await waitUntil(() => observer.snapshot().connection === 'disconnected')

    expect(clients[0].disposed).toBe(true)
    expect(owner.snapshot().membershipChannelId).toBeNull()
    await Promise.all([owner.dispose(), observer.dispose()])
  })
})

function initialSnapshot(): VoiceSnapshot {
  return {
    intentChannelId: null,
    membershipChannelId: null,
    connection: 'disconnected',
    microphone: { state: 'off' },
    output: { state: 'off' },
    camera: { state: 'off' },
    screen: { state: 'off' },
    screenAudio: { state: 'off' },
    userMuted: true,
    userDeafened: false,
    serverMuted: false,
    serverDeafened: false,
    systemPrivacyMuted: false,
    monitoringMuted: false,
    inputMode: 'voice_activity',
    pushToTalkHeld: false,
    effectiveMuted: true,
    speakingUserIds: [],
  }
}
