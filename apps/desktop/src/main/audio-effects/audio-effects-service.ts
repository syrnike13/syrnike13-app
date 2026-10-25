import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  AudioEffectChainSchema,
  type AudioEffectSlot,
  type AudioEffectSlotStatus,
  type AudioEffectSlotUpdate,
  type AudioEffectsState,
  type AudioEffectsStats,
  type AudioPluginCatalog,
  type AudioPluginInfo,
} from '@syrnike13/platform'
import { Option, Schema } from 'effect'

import {
  PluginHostProcess,
  runPluginHostOnce,
  type PluginHostCrash,
  type PluginHostEvent,
  type PluginHostReply,
  type SpawnPluginHost,
} from './plugin-host-process'

const CHAIN_FILE = 'audio-effects.json'
const CATALOG_FILE = 'audio-plugins.json'
// One JSON line per unexpected host exit, newest last, bounded.
const HOST_LOG_FILE = 'audio-plugin-host.jsonl'
const HOST_LOG_LINES = 200
const CRASH_DIRECTORY = 'audio-plugin-crashes'
const KEPT_CRASH_DUMPS = 5
const SCAN_TIMEOUT_MS = 20_000
const SCAN_CONCURRENCY = 2
const PERSIST_DELAY_MS = 500
// A plugin state is base64 of the plugin's own chunk. A runaway one must not
// stall the main process or bloat the settings file, so oversized states are
// dropped (the plugin works, it just does not restore next time).
const MAX_STATE_BYTES = 1024 * 1024
// A host that keeps dying (a plugin crashing on load) stops being restarted
// until the user changes the chain.
const MAX_CONSECUTIVE_CRASHES = 3
const STABLE_HOST_MS = 60_000

const StoredChainSchema = Schema.fromJsonString(Schema.Struct({
  version: Schema.Literal(1),
  slots: AudioEffectChainSchema,
  states: Schema.Record(Schema.String, Schema.String),
}))

type StoredModule = {
  path: string
  mtimeMs: number
  size: number
  plugins: AudioPluginInfo[]
  error?: string
}

export type AudioEffectsServiceOptions = {
  storageDir: string
  /** Null when the packaged host is missing (non-Windows, broken install). */
  executablePath: () => string | null
  ownerWindowHandle: () => string | null
  onState: (state: AudioEffectsState) => void
  onCatalog: (catalog: AudioPluginCatalog) => void
  spawnHost?: SpawnPluginHost
}

/** Main-process owner of the microphone effect chain and its plugin host. */
export class AudioEffectsService {
  private slots: AudioEffectSlot[] = []
  private states: Record<string, string> = {}
  private statuses = new Map<string, AudioEffectSlotStatus>()
  private host: PluginHostProcess | null = null
  private hostStatus: AudioEffectsState['host'] = 'idle'
  private hostStartedAt = 0
  private crashes = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private writes: Promise<void> = Promise.resolve()
  private applying: Promise<void> = Promise.resolve()
  private busListeners = new Set<(busId: string | null) => void>()
  private busId: string | null = null
  private catalog: AudioPluginCatalog = { scanning: false, plugins: [], failures: [] }
  private scanning: Promise<AudioPluginCatalog> | null = null
  private disposed = false
  // Slots whose plugin crashed the host; they stay out of the chain until the
  // user switches them on again, so one bad plugin does not take the others.
  private quarantined = new Set<string>()
  private lastCrash: PluginHostCrash | null = null
  private lastExitReason: string | null = null
  private ignoredQuits = 0
  private oversizedStates = new Set<string>()

  constructor(private readonly options: AudioEffectsServiceOptions) {}

  async load(): Promise<void> {
    const text = await readFile(path.join(this.options.storageDir, CHAIN_FILE), 'utf8').catch(() => null)
    const stored = text === null ? Option.none() : Schema.decodeUnknownOption(StoredChainSchema)(text)
    if (Option.isSome(stored)) {
      this.slots = [...stored.value.slots]
      this.states = { ...stored.value.states }
    }
    const modules = await this.readCatalog()
    this.catalog = projectCatalog(modules, false)
    await this.apply()
  }

  state(): AudioEffectsState {
    return {
      host: this.hostStatus,
      slots: this.slots,
      statuses: this.slots.map(slot => this.quarantined.has(slot.slotId)
        ? { slotId: slot.slotId, state: 'failed', hasEditor: false, crashed: true }
        : this.statuses.get(slot.slotId) ?? { slotId: slot.slotId, state: 'loading', hasEditor: false }),
    }
  }

  currentBusId(): string | null { return this.busId }

  onBusChange(listener: (busId: string | null) => void): () => void {
    this.busListeners.add(listener)
    return () => this.busListeners.delete(listener)
  }

  async setChain(requested: readonly AudioEffectSlot[]): Promise<AudioEffectsState> {
    // The renderer names the module the host loads as a DLL. Accept only
    // plugins the scan found in the standard VST3 folders, or ones already in
    // the chain, so a compromised page cannot load code from any path.
    const slots = requested.filter(slot => slot.kind === 'builtin' || this.isKnownPlugin(slot))
    const ids = new Set(slots.map(slot => slot.slotId))
    this.slots = [...slots]
    for (const id of Object.keys(this.states)) if (!ids.has(id)) delete this.states[id]
    for (const id of [...this.statuses.keys()]) if (!ids.has(id)) this.statuses.delete(id)
    for (const id of [...this.quarantined]) if (!ids.has(id)) this.quarantined.delete(id)
    for (const id of [...this.oversizedStates]) if (!ids.has(id)) this.oversizedStates.delete(id)
    // An explicit change is the user's retry after repeated host crashes.
    this.crashes = 0
    this.schedulePersist()
    await this.apply()
    return this.state()
  }

  private isKnownPlugin(slot: { path: string, classId: string }): boolean {
    const matches = (value: { path: string, classId: string }) =>
      value.path === slot.path && value.classId === slot.classId
    return this.catalog.plugins.some(matches)
      || this.slots.some(value => value.kind === 'vst3' && matches(value))
  }

  updateSlot(update: AudioEffectSlotUpdate): void {
    const index = this.slots.findIndex(slot => slot.slotId === update.slotId)
    if (index < 0) return
    const slot = this.slots[index]!
    const next: AudioEffectSlot = slot.kind === 'builtin'
      ? { ...slot, ...pick(update), params: { ...slot.params, ...update.params } }
      : { ...slot, ...pick(update) }
    this.slots = this.slots.map(value => value === slot ? next : value)
    this.schedulePersist()
    if (update.enabled && this.quarantined.delete(update.slotId)) {
      // Switching a crashed plugin on again is the user's retry.
      this.statuses.delete(update.slotId)
      void this.apply()
    } else {
      this.host?.send({ type: 'updateSlot', ...update })
    }
    this.options.onState(this.state())
  }

  /** Processing load per slot and of the host process; null while no host runs. */
  async stats(): Promise<AudioEffectsStats | null> {
    if (!this.host?.alive || this.hostStatus !== 'running') return null
    const reply = await this.host.request({ type: 'stats' }).catch(() => null)
    if (reply?.ok !== true || !Array.isArray(reply.slots)) return null
    const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0
    return {
      processCpuPercent: number(reply.processCpuPercent),
      audioThreadCpuPercent: number(reply.audioThreadCpuPercent),
      privateMegabytes: number(reply.privateMegabytes),
      slots: reply.slots.flatMap(value => value && typeof value === 'object' && typeof value.slotId === 'string'
        ? [{ slotId: value.slotId, averageUs: number(value.averageUs), p99Us: number(value.p99Us),
             maxUs: number(value.maxUs), overDeadline: number(value.overDeadline) }]
        : []),
    }
  }

  async openEditor(slotId: string): Promise<boolean> {
    const slot = this.slots.find(value => value.slotId === slotId)
    if (!slot || slot.kind !== 'vst3' || !this.host?.alive) return false
    const reply = await this.host.request({
      type: 'openEditor', slotId, title: slot.name, owner: this.options.ownerWindowHandle() ?? undefined,
    }).catch(() => null)
    return reply?.ok === true
  }

  getCatalog(): AudioPluginCatalog { return this.catalog }

  /** Rescans changed modules; unchanged ones come from the cache. */
  scanPlugins(): Promise<AudioPluginCatalog> {
    if (this.scanning) return this.scanning
    this.scanning = this.scan().finally(() => { this.scanning = null })
    return this.scanning
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
      this.persist()
    }
    const host = this.host
    this.host = null
    this.setBus(null)
    await host?.stop()
    await this.writes
  }

  private apply(): Promise<void> {
    this.applying = this.applying.then(() => this.applyNow()).catch(() => undefined)
    return this.applying
  }

  private async applyNow(): Promise<void> {
    if (this.disposed) return
    if (this.slots.length === 0) {
      const host = this.host
      this.host = null
      this.hostStatus = 'idle'
      this.setBus(null)
      this.options.onState(this.state())
      await host?.stop()
      return
    }
    const executable = this.options.executablePath()
    if (!executable) {
      this.fail('The audio plugin host is not installed')
      return
    }
    if (!this.host?.alive) {
      if (this.crashes >= MAX_CONSECUTIVE_CRASHES) {
        this.fail('The audio plugin host keeps crashing; remove the last added plugin')
        return
      }
      this.startHost(executable)
    }
    const host = this.host!
    try {
      await host.ready
    } catch (error) {
      if (host === this.host) this.fail(errorMessage(error))
      return
    }
    for (const slot of this.slots)
      if (!this.statuses.has(slot.slotId)) this.statuses.set(slot.slotId, { slotId: slot.slotId, state: 'loading', hasEditor: false })
    this.options.onState(this.state())
    let reply: PluginHostReply
    try {
      reply = await host.request({
        type: 'setChain',
        slots: this.slots.filter(slot => !this.quarantined.has(slot.slotId)).map(slot => this.hostSlot(slot)),
      })
    } catch (error) {
      if (host === this.host) this.fail(errorMessage(error))
      return
    }
    if (host !== this.host) return
    for (const status of Array.isArray(reply.slots) ? reply.slots : []) {
      if (!status || typeof status !== 'object' || typeof status.slotId !== 'string') continue
      this.statuses.set(status.slotId, status.ok === true
        ? { slotId: status.slotId, state: 'ready', hasEditor: status.hasEditor === true,
            latencySamples: typeof status.latencySamples === 'number' ? status.latencySamples : 0 }
        : { slotId: status.slotId, state: 'failed', hasEditor: false,
            error: typeof status.error === 'string' ? status.error : undefined })
    }
    this.hostStatus = 'running'
    this.setBus(host.busId)
    this.options.onState(this.state())
  }

  private hostSlot(slot: AudioEffectSlot) {
    return slot.kind === 'builtin'
      ? slot
      : { ...slot, ...(this.states[slot.slotId] ? { state: this.states[slot.slotId] } : {}) }
  }

  private startHost(executable: string) {
    this.hostStatus = 'starting'
    this.hostStartedAt = Date.now()
    this.lastCrash = null
    this.lastExitReason = null
    this.ignoredQuits = 0
    const host = new PluginHostProcess(executable, event => this.observe(host, event), this.options.spawnHost,
      path.join(this.options.storageDir, CRASH_DIRECTORY))
    this.host = host
    void host.exit.then(code => {
      if (host !== this.host || this.disposed) return
      // The DSP already keeps the voice dry; drop the dead bus and come back.
      this.host = null
      this.setBus(null)
      const crash = this.lastCrash
      const culprit = crash ? this.slots.find(slot => crash.activity.startsWith(`${slot.slotId} `)) : undefined
      this.recordExit(code, crash, culprit?.slotId ?? null)
      if (culprit && !this.quarantined.has(culprit.slotId)) {
        // The crash names its plugin: run the rest of the chain without it.
        this.quarantined.add(culprit.slotId)
        this.crashes = 0
      } else {
        this.crashes = Date.now() - this.hostStartedAt > STABLE_HOST_MS ? 1 : this.crashes + 1
      }
      for (const slot of this.slots) this.statuses.delete(slot.slotId)
      this.hostStatus = this.crashes >= MAX_CONSECUTIVE_CRASHES ? 'failed' : 'starting'
      this.options.onState(this.state())
      if (this.crashes >= MAX_CONSECUTIVE_CRASHES) return void this.apply()
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        void this.apply()
      }, 1_000 * Math.max(1, this.crashes))
      this.restartTimer.unref?.()
    })
  }

  private observe(host: PluginHostProcess, event: PluginHostEvent) {
    if (host !== this.host) return
    if (event.event === 'state') {
      if (!this.slots.some(slot => slot.slotId === event.slotId)) return
      if (event.state.length > MAX_STATE_BYTES) {
        if (!this.oversizedStates.has(event.slotId)) {
          this.oversizedStates.add(event.slotId)
          console.warn('[audio-effects] the plugin state is too large to save', {
            slotId: event.slotId, bytes: event.state.length,
          })
        }
        return
      }
      this.oversizedStates.delete(event.slotId)
      this.states[event.slotId] = event.state
      this.schedulePersist()
    } else if (event.event === 'slotFailed') {
      this.statuses.set(event.slotId, { slotId: event.slotId, state: 'failed', hasEditor: false, error: event.error })
      this.options.onState(this.state())
    } else if (event.event === 'crash') {
      this.lastCrash = event.crash
    } else if (event.event === 'exit') {
      this.lastExitReason = event.reason
    } else {
      this.ignoredQuits += 1
    }
  }

  private recordExit(code: number | null, crash: PluginHostCrash | null, culprit: string | null) {
    const record = {
      at: new Date().toISOString(),
      uptimeMs: Date.now() - this.hostStartedAt,
      code: code === null ? null : `0x${(code >>> 0).toString(16).toUpperCase()}`,
      reason: this.lastExitReason ?? (crash ? 'crash' : 'unexpected'),
      ...(crash ? { crash } : {}),
      ...(culprit ? { culprit } : {}),
      ...(this.ignoredQuits ? { ignoredPluginQuits: this.ignoredQuits } : {}),
      chain: this.slots.map(slot => slot.kind === 'builtin' ? `builtin:${slot.builtin}` : `${slot.vendor} ${slot.name}`),
    }
    console.warn('[audio-effects] plugin host exited', record)
    const file = path.join(this.options.storageDir, HOST_LOG_FILE)
    this.writes = this.writes.then(async () => {
      await mkdir(this.options.storageDir, { recursive: true })
      await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8')
      const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean)
      if (lines.length > HOST_LOG_LINES) await writeAtomically(file, `${lines.slice(-HOST_LOG_LINES).join('\n')}\n`)
      await pruneDumps(path.join(this.options.storageDir, CRASH_DIRECTORY))
    }).catch(error => console.error('[audio-effects] failed to record a host exit', error))
  }

  private fail(error: string) {
    this.hostStatus = 'failed'
    this.setBus(null)
    for (const slot of this.slots) this.statuses.set(slot.slotId, { slotId: slot.slotId, state: 'failed', hasEditor: false, error })
    this.options.onState(this.state())
  }

  private setBus(busId: string | null) {
    if (this.busId === busId) return
    this.busId = busId
    for (const listener of this.busListeners) listener(busId)
  }

  private schedulePersist() {
    if (this.persistTimer || this.disposed) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.persist()
    }, PERSIST_DELAY_MS)
    this.persistTimer.unref?.()
  }

  private persist() {
    const content = JSON.stringify({ version: 1, slots: this.slots, states: this.states })
    this.writes = this.writes
      .then(() => writeAtomically(path.join(this.options.storageDir, CHAIN_FILE), content))
      .catch(error => console.error('[audio-effects] failed to save the effect chain', error))
  }

  private async readCatalog(): Promise<StoredModule[]> {
    const text = await readFile(path.join(this.options.storageDir, CATALOG_FILE), 'utf8').catch(() => null)
    if (!text) return []
    try {
      const value = JSON.parse(text) as { version?: unknown; modules?: unknown }
      return value.version === 1 && Array.isArray(value.modules) ? value.modules as StoredModule[] : []
    } catch {
      return []
    }
  }

  private async scan(): Promise<AudioPluginCatalog> {
    const executable = this.options.executablePath()
    if (!executable) return this.catalog
    this.catalog = { ...this.catalog, scanning: true }
    this.options.onCatalog(this.catalog)
    const cached = new Map((await this.readCatalog()).map(module => [module.path, module]))
    const listed = await runPluginHostOnce(executable, ['--list-modules'], SCAN_TIMEOUT_MS, this.options.spawnHost)
    const paths = Array.isArray(listed?.modules)
      ? listed.modules.filter((value): value is string => typeof value === 'string')
      : []
    const modules: StoredModule[] = []
    let next = 0
    const worker = async () => {
      while (next < paths.length) {
        const modulePath = paths[next++]!
        const info = await stat(modulePath).catch(() => null)
        const mtimeMs = info?.mtimeMs ?? 0
        const size = info?.size ?? 0
        const previous = cached.get(modulePath)
        if (previous && previous.mtimeMs === mtimeMs && previous.size === size) {
          modules.push(previous)
          continue
        }
        // One process per module: a plugin that crashes or hangs while
        // loading only fails its own entry.
        const result = await runPluginHostOnce(executable, ['--scan', modulePath], SCAN_TIMEOUT_MS, this.options.spawnHost)
        const plugins = Array.isArray(result?.plugins) ? result.plugins.filter(isPluginInfo) : []
        // A module without effects (an instrument) is cached without an error.
        const error = !result ? 'The plugin did not load' : typeof result.error === 'string' ? result.error : undefined
        modules.push({ path: modulePath, mtimeMs, size, plugins, ...(error ? { error } : {}) })
      }
    }
    await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker))
    modules.sort((a, b) => a.path.localeCompare(b.path))
    await writeAtomically(path.join(this.options.storageDir, CATALOG_FILE), JSON.stringify({ version: 1, modules }))
      .catch(error => console.error('[audio-effects] failed to save the plugin catalog', error))
    this.catalog = projectCatalog(modules, false)
    this.options.onCatalog(this.catalog)
    return this.catalog
  }
}

async function pruneDumps(directory: string) {
  const names = (await readdir(directory).catch(() => [] as string[])).filter(name => name.endsWith('.dmp')).sort()
  for (const name of names.slice(0, Math.max(0, names.length - KEPT_CRASH_DUMPS)))
    await rm(path.join(directory, name), { force: true })
}

function pick(update: AudioEffectSlotUpdate) {
  return {
    ...(update.mix === undefined ? {} : { mix: update.mix }),
    ...(update.enabled === undefined ? {} : { enabled: update.enabled }),
  }
}

function projectCatalog(modules: readonly StoredModule[], scanning: boolean): AudioPluginCatalog {
  return {
    scanning,
    plugins: modules.flatMap(module => module.plugins)
      .sort((a, b) => a.name.localeCompare(b.name) || a.vendor.localeCompare(b.vendor)),
    failures: modules.flatMap(module => module.error ? [{ path: module.path, error: module.error }] : []),
  }
}

function isPluginInfo(value: unknown): value is AudioPluginInfo {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return ['path', 'classId', 'name', 'vendor', 'version', 'subCategories']
    .every(key => typeof record[key] === 'string')
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function writeAtomically(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.tmp`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, filePath)
}
