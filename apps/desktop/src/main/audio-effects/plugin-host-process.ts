import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'

type Json = Record<string, unknown>

export type PluginHostCrash = {
  code: string
  module: string
  thread: string
  /** Label of the plugin code the thread ran: "<slotId> <name>", or a host phase. */
  activity: string
  dump: string
}

export type PluginHostEvent =
  | { event: 'state'; slotId: string; state: string }
  | { event: 'slotFailed'; slotId: string; error: string }
  | { event: 'crash'; crash: PluginHostCrash }
  | { event: 'exit'; reason: string }
  | { event: 'pluginQuitIgnored' }

export type PluginHostReply = Json & { ok?: boolean }

const REQUEST_TIMEOUT_MS = 15_000
const START_TIMEOUT_MS = 10_000
const MAX_LINE = 16 * 1024 * 1024

export type SpawnPluginHost = (executable: string, args: string[]) => ChildProcessWithoutNullStreams

const spawnHidden: SpawnPluginHost = (executable, args) =>
  spawn(executable, args, { stdio: 'pipe', windowsHide: true })

/** One plugin host process: JSON lines over stdio, one effect bus. */
export class PluginHostProcess {
  readonly busId = `fx-${randomBytes(12).toString('hex')}`
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, {
    resolve(reply: PluginHostReply): void
    reject(error: Error): void
    timer: ReturnType<typeof setTimeout>
  }>()
  private nextRequestId = 1
  private buffer = ''
  private exited = false
  readonly ready: Promise<void>
  readonly exit: Promise<number | null>

  constructor(
    executable: string,
    private readonly onEvent: (event: PluginHostEvent) => void,
    spawnHost: SpawnPluginHost = spawnHidden,
    crashDirectory?: string,
  ) {
    this.child = spawnHost(executable, [
      '--bus', this.busId, '--parent', String(process.pid),
      ...(crashDirectory ? ['--crash-dir', crashDirectory] : []),
    ])
    let markReady: () => void = () => undefined
    let failReady: (error: Error) => void = () => undefined
    this.ready = new Promise((resolve, reject) => { markReady = resolve; failReady = reject })
    // A late rejection must not surface as unhandled after a successful stop.
    this.ready.catch(() => undefined)
    const startTimer = setTimeout(() => failReady(new Error('Plugin host did not start')), START_TIMEOUT_MS)
    startTimer.unref?.()
    this.exit = new Promise(resolve => {
      this.child.once('exit', code => {
        this.exited = true
        clearTimeout(startTimer)
        failReady(new Error('Plugin host exited'))
        for (const request of this.pending.values()) {
          clearTimeout(request.timer)
          request.reject(new Error('Plugin host exited'))
        }
        this.pending.clear()
        resolve(code)
      })
    })
    this.child.once('error', error => failReady(error))
    this.child.stdin.on('error', () => undefined)
    this.child.stderr.resume()
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      if (this.buffer.length > MAX_LINE) {
        this.kill()
        return
      }
      for (let end = this.buffer.indexOf('\n'); end >= 0; end = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, end)
        this.buffer = this.buffer.slice(end + 1)
        const message = parse(line)
        if (!message) continue
        if (message.event === 'ready') {
          clearTimeout(startTimer)
          markReady()
        } else if (message.event === 'failed') {
          failReady(new Error(typeof message.error === 'string' ? message.error : 'Plugin host failed'))
        } else if (message.type === 'reply' && typeof message.requestId === 'number') {
          const request = this.pending.get(message.requestId)
          if (!request) continue
          this.pending.delete(message.requestId)
          clearTimeout(request.timer)
          request.resolve(message)
        } else if (message.event === 'state' && typeof message.slotId === 'string' &&
          typeof message.state === 'string') {
          this.onEvent({ event: 'state', slotId: message.slotId, state: message.state })
        } else if (message.event === 'slotFailed' && typeof message.slotId === 'string') {
          this.onEvent({ event: 'slotFailed', slotId: message.slotId,
            error: typeof message.error === 'string' ? message.error : '' })
        } else if (message.event === 'crash') {
          const text = (key: string) => typeof message[key] === 'string' ? message[key] as string : ''
          this.onEvent({ event: 'crash', crash: {
            code: text('code'), module: text('module'), thread: text('thread'),
            activity: text('activity'), dump: text('dump'),
          } })
        } else if (message.event === 'exit' && typeof message.reason === 'string') {
          this.onEvent({ event: 'exit', reason: message.reason })
        } else if (message.event === 'pluginQuitIgnored') {
          this.onEvent({ event: 'pluginQuitIgnored' })
        }
      }
    })
  }

  get alive() { return !this.exited }

  request(command: Json): Promise<PluginHostReply> {
    if (this.exited) return Promise.reject(new Error('Plugin host exited'))
    const requestId = this.nextRequestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('Plugin host did not answer'))
      }, REQUEST_TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(requestId, { resolve, reject, timer })
      this.send({ ...command, requestId })
    })
  }

  send(command: Json): void {
    if (this.exited) return
    this.child.stdin.write(`${JSON.stringify(command)}\n`)
  }

  /** Asks for a clean exit, then kills a host that does not leave in time. */
  async stop(): Promise<void> {
    if (this.exited) return
    this.send({ type: 'shutdown' })
    const timer = setTimeout(() => this.kill(), 2_000)
    timer.unref?.()
    await this.exit
    clearTimeout(timer)
  }

  kill(): void {
    if (!this.exited) this.child.kill()
  }
}

function parse(line: string): Json | null {
  try {
    const value: unknown = JSON.parse(line)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null
  } catch {
    return null
  }
}

/** Runs the host in a one-shot mode and returns its single JSON line. */
export function runPluginHostOnce(
  executable: string,
  args: string[],
  timeoutMs: number,
  spawnHost: SpawnPluginHost = spawnHidden,
): Promise<Json | null> {
  return new Promise(resolve => {
    const child = spawnHost(executable, args)
    let output = ''
    let settled = false
    const finish = (value: Json | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (child.exitCode === null) child.kill()
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    timer.unref?.()
    child.stdin.end()
    child.stderr.resume()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
      if (output.length > MAX_LINE) finish(null)
    })
    child.once('error', () => finish(null))
    child.once('exit', () => {
      const line = output.split('\n').find(value => value.trim().length > 0)
      finish(line ? parse(line) : null)
    })
  })
}
