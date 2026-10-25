import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import type { AudioEffectSlot, AudioEffectsState } from '@syrnike13/platform'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AudioEffectsService } from './audio-effects-service'

type Command = Record<string, unknown> & { type: string; requestId?: number }

/** Scripted stand-in for syrnike_audio_plugin_host.exe. */
class FakeHost extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  readonly commands: Command[] = []
  constructor(readonly args: string[], private readonly respond: (host: FakeHost, command: Command) => void) {
    super()
    let buffer = ''
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (chunk: string) => {
      buffer += chunk
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const command = JSON.parse(buffer.slice(0, end)) as Command
        buffer = buffer.slice(end + 1)
        this.commands.push(command)
        this.respond(this, command)
      }
    })
  }
  write(value: unknown) { this.stdout.write(`${JSON.stringify(value)}\n`) }
  kill() { this.crash(1) }
  crash(code = 3) {
    if (this.exitCode !== null) return
    this.exitCode = code
    this.emit('exit', code)
  }
}

const builtin = (slotId: string, mix = 1): AudioEffectSlot =>
  ({ slotId, kind: 'builtin', builtin: 'eq', mix, enabled: true, params: { lowGainDb: 6 } })
const plugin = (slotId: string): AudioEffectSlot => ({
  slotId, kind: 'vst3', path: 'C:/VST3/Room.vst3', classId: '0123456789ABCDEF0123456789ABCDEF',
  name: 'Room', vendor: 'Vendor', mix: 0.5, enabled: true,
})

function setup(storageDir: string, overrides: { scan?: (args: string[]) => unknown } = {}) {
  const hosts: FakeHost[] = []
  const states: AudioEffectsState[] = []
  const buses: Array<string | null> = []
  const spawnHost = vi.fn((_executable: string, args: string[]) => {
    const host = new FakeHost(args, (current, command) => {
      if (command.type === 'setChain') {
        const slots = command.slots as Array<{ slotId: string }>
        current.write({ type: 'reply', requestId: command.requestId, ok: true,
          slots: slots.map(slot => ({ slotId: slot.slotId, ok: true, latencySamples: 0, hasEditor: false })) })
      } else if (command.type === 'shutdown') {
        current.crash(0)
      }
    })
    if (args[0] === '--bus') {
      hosts.push(host)
      queueMicrotask(() => host.write({ event: 'ready' }))
    } else {
      queueMicrotask(() => {
        host.write(overrides.scan?.(args) ?? {})
        host.crash(0)
      })
    }
    return host as unknown as ChildProcessWithoutNullStreams
  })
  const service = new AudioEffectsService({
    storageDir,
    executablePath: () => 'C:/host.exe',
    ownerWindowHandle: () => '42',
    onState: state => states.push(state),
    onCatalog: () => undefined,
    spawnHost,
  })
  service.onBusChange(bus => buses.push(bus))
  return { service, hosts, states, buses, spawnHost }
}

describe('AudioEffectsService', () => {
  let storageDir = ''
  beforeEach(async () => { storageDir = await mkdtemp(path.join(tmpdir(), 'syrnike-effects-')) })
  afterEach(async () => {
    vi.useRealTimers()
    await rm(storageDir, { recursive: true, force: true })
  })

  it('starts the host for a chain and announces its bus once it is ready', async () => {
    const { service, hosts, buses } = setup(storageDir)
    await service.load()
    expect(hosts).toHaveLength(0)
    const state = await service.setChain([builtin('a')])
    expect(hosts).toHaveLength(1)
    const busId = hosts[0]!.args[1]
    expect(busId).toMatch(/^fx-[0-9a-f]{24}$/)
    expect(buses).toEqual([busId])
    expect(state.host).toBe('running')
    expect(state.statuses).toEqual([{ slotId: 'a', state: 'ready', hasEditor: false, latencySamples: 0 }])
    await service.setChain([])
    expect(buses).toEqual([busId, null])
    expect(hosts[0]!.exitCode).toBe(0)
    await service.dispose()
  })

  it('forwards live slot updates without rebuilding the chain', async () => {
    const { service, hosts } = setup(storageDir)
    await service.setChain([builtin('a')])
    service.updateSlot({ slotId: 'a', mix: 0.25, params: { midGainDb: -3 } })
    await vi.waitFor(() => expect(hosts[0]!.commands.at(-1)).toMatchObject({ type: 'updateSlot', mix: 0.25 }))
    expect(service.state().slots[0]).toMatchObject({ mix: 0.25, params: { lowGainDb: 6, midGainDb: -3 } })
    expect(hosts[0]!.commands.filter(command => command.type === 'setChain')).toHaveLength(1)
    await service.dispose()
  })

  it('persists plugin state from the host and restores it into a new host', async () => {
    const first = setup(storageDir)
    await first.service.setChain([plugin('p')])
    first.hosts[0]!.write({ event: 'state', slotId: 'p', state: 'U1hWMw==' })
    await vi.waitFor(() => expect(first.service['states']).toEqual({ p: 'U1hWMw==' }))
    await first.service.dispose()
    const stored = JSON.parse(await readFile(path.join(storageDir, 'audio-effects.json'), 'utf8'))
    expect(stored).toMatchObject({ version: 1, slots: [{ slotId: 'p' }], states: { p: 'U1hWMw==' } })

    const second = setup(storageDir)
    await second.service.load()
    const setChain = second.hosts[0]!.commands.find(command => command.type === 'setChain')
    expect(setChain?.slots).toEqual([{ ...plugin('p'), state: 'U1hWMw==' }])
    await second.service.dispose()
  })

  it('drops a plugin state too large to keep', async () => {
    const { service, hosts } = setup(storageDir)
    await service.setChain([plugin('p')])
    hosts[0]!.write({ event: 'state', slotId: 'p', state: 'U1hWMw==' })
    await vi.waitFor(() => expect(service['states']).toEqual({ p: 'U1hWMw==' }))
    // A state that could not fit the settings file is refused instead of
    // stalling the main process with base64 of tens of megabytes.
    hosts[0]!.write({ event: 'state', slotId: 'p', state: 'A'.repeat(1024 * 1024 + 1) })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(service['states']).toEqual({ p: 'U1hWMw==' })
    await service.dispose()
  })

  it('drops the bus of a crashed host and comes back with a new one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { service, hosts, buses } = setup(storageDir)
    await service.setChain([builtin('a')])
    hosts[0]!.crash()
    await vi.waitFor(() => expect(buses.at(-1)).toBeNull())
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(hosts).toHaveLength(2))
    await vi.waitFor(() => expect(buses.at(-1)).toBe(hosts[1]!.args[1]))
    expect(hosts[1]!.args[1]).not.toBe(hosts[0]!.args[1])
    await service.dispose()
  })

  it('stops restarting a host that keeps crashing until the chain changes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { service, hosts } = setup(storageDir)
    await service.setChain([plugin('p')])
    for (let crash = 1; crash <= 3; ++crash) {
      await vi.waitFor(() => expect(hosts).toHaveLength(crash))
      hosts[crash - 1]!.crash()
      await vi.advanceTimersByTimeAsync(1_000 * crash)
    }
    await vi.waitFor(() => expect(service.state().host).toBe('failed'))
    expect(hosts).toHaveLength(3)
    await service.setChain([builtin('a')])
    expect(hosts).toHaveLength(4)
    expect(service.state().host).toBe('running')
    await service.dispose()
  })

  it('quarantines the plugin a crash names and keeps the rest of the chain running', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { service, hosts, buses } = setup(storageDir)
    await service.setChain([builtin('a'), plugin('p')])
    hosts[0]!.write({ event: 'crash', code: '0xC0000005', module: 'Room.vst3+0x10', thread: 'audio',
      activity: 'p Room', dump: 'plugin-host-1.dmp' })
    await vi.waitFor(() => expect(service['lastCrash']).not.toBeNull())
    hosts[0]!.crash(0xC0000005)
    await vi.waitFor(() => expect(buses.at(-1)).toBeNull())
    expect(service.state().statuses).toContainEqual({ slotId: 'p', state: 'failed', hasEditor: false, crashed: true })
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(service.state().host).toBe('running'))
    const restarted = hosts[1]!.commands.find(command => command.type === 'setChain')
    expect((restarted?.slots as AudioEffectSlot[]).map(slot => slot.slotId)).toEqual(['a'])
    // Switching the plugin on again retries it in the running host.
    service.updateSlot({ slotId: 'p', enabled: true })
    await vi.waitFor(() => expect(hosts[1]!.commands.filter(command => command.type === 'setChain')).toHaveLength(2))
    expect(service.state().statuses.find(status => status.slotId === 'p')?.crashed).toBeUndefined()
    await service.dispose()
    const log = (await readFile(path.join(storageDir, 'audio-plugin-host.jsonl'), 'utf8')).trim().split('\n')
    expect(JSON.parse(log[0]!)).toMatchObject({
      code: '0xC0000005', reason: 'crash', culprit: 'p', crash: { module: 'Room.vst3+0x10', thread: 'audio' },
      chain: ['builtin:eq', 'Vendor Room'],
    })
  })

  it('records the reason of a host that exits on its own', async () => {
    const { service, hosts } = setup(storageDir)
    await service.setChain([builtin('a')])
    hosts[0]!.write({ event: 'exit', reason: 'stdin_closed' })
    await vi.waitFor(() => expect(service['lastExitReason']).toBe('stdin_closed'))
    hosts[0]!.crash(10)
    await vi.waitFor(async () => {
      const log = await readFile(path.join(storageDir, 'audio-plugin-host.jsonl'), 'utf8').catch(() => '')
      expect(log).toContain('"reason":"stdin_closed"')
    })
    await service.dispose()
  })

  it('scans each changed module in its own process and reuses the cache', async () => {
    const modulePath = path.join(storageDir, 'Room.vst3')
    await writeFile(modulePath, 'module')
    const info = { path: modulePath, classId: 'C', name: 'Room', vendor: 'V', version: '1', subCategories: 'Fx' }
    const { service, spawnHost } = setup(storageDir, {
      scan: args => args[0] === '--list-modules'
        ? { modules: [modulePath, 'C:/missing/Broken.vst3'] }
        : args[1] === modulePath ? { plugins: [info] } : { plugins: [], error: 'LoadLibraryW failed' },
    })
    const catalog = await service.scanPlugins()
    expect(catalog.plugins).toEqual([info])
    expect(catalog.failures).toEqual([{ path: 'C:/missing/Broken.vst3', error: 'LoadLibraryW failed' }])
    const scans = () => spawnHost.mock.calls.filter(([, args]) => args[0] === '--scan').length
    expect(scans()).toBe(2)
    await service.scanPlugins()
    // Unchanged modules, failed ones included, are not loaded again.
    expect(scans()).toBe(2)
    await service.dispose()
  })
})
