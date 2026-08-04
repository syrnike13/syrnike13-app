const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const Module = require('node:module')
const path = require('node:path')
const test = require('node:test')

const fakeElectron = {
  app: {
    whenReady() {
      return Promise.resolve()
    },
    exit() {},
  },
  utilityProcess: {
    fork() {
      throw new Error('utilityProcess.fork must be stubbed per test')
    },
  },
}

const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return fakeElectron
  return originalLoad.call(this, request, parent, isMain)
}
const smokeHost = require('./smoke-utility-host.cjs')
Module._load = originalLoad
const { NativeRuntimeSupervisor } = require(
  path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'apps',
    'desktop',
    'out',
    'utility',
    'runtime-supervisor.cjs',
  ),
)

const manifest = {
  appVersion: '0.0.0-test',
  releaseChannel: 'test',
  contractVersion: 7,
  liveKitVersion: '1.2.3-test',
  commitSha: 'abc123',
  napiVersion: 8,
}

test('reports observable control traffic when the native request hangs', async () => {
  const scheduler = createManualScheduler()
  const events = []
  const child = new FakeUtilityChild((message) => {
    if (message.command?.type !== 'stopPreview') return
    child.emit('message', {
      type: 'control',
      control: { type: 'native_request_pending' },
    })
  })
  const context = createTestContext({
    child,
    events,
    scheduler,
  })

  const pending = smokeHost.smokeRuntime(
    context,
    'media',
    'media-host.cjs',
    'syrnike_media.node',
  )

  child.emit('message', createReadyMessage('media'))
  await new Promise(setImmediate)
  scheduler.flush()

  await assert.rejects(
    pending,
    /Timed out during media utility host command; observed .*host:postMessage:media:command:request,request=media-\d+-[^,]+,command=stopPreview.*child:message:media:command:control,control=native_request_pending/,
  )
  assert.equal(child.killCalls, 1)
  assert.ok(
    events.some(
      (entry) =>
        entry.direction === 'child' &&
        entry.event === 'message' &&
        entry.detail === 'control,control=native_request_pending',
    ),
  )
})

test('reports observable control traffic when the native request fails', async () => {
  const scheduler = createManualScheduler()
  const events = []
  const child = new FakeUtilityChild((message) => {
    if (message.command?.type !== 'stopPreview') return
    child.emit('message', {
      type: 'control',
      control: { type: 'native_request_failed' },
    })
    child.emit('message', {
      type: 'reply',
      requestId: message.requestId,
      ok: false,
      error: {
        code: 'internal',
        message: 'native smoke command failed',
        retryable: false,
      },
    })
  })
  const context = createTestContext({
    child,
    events,
    scheduler,
  })

  const pending = smokeHost.smokeRuntime(
    context,
    'media',
    'media-host.cjs',
    'syrnike_media.node',
  )

  child.emit('message', createReadyMessage('media'))

  await assert.rejects(
    pending,
    /media DLL rejected the smoke command: native smoke command failed; observed .*child:message:media:command:control,control=native_request_failed.*child:message:media:command:reply,request=media-\d+-[^,]+,error/,
  )
  assert.equal(child.killCalls, 1)
  assert.ok(
    events.some(
      (entry) =>
        entry.direction === 'host' &&
        entry.event === 'postMessage' &&
        entry.detail.startsWith('request,request=media-') &&
        entry.detail.endsWith(',command=stopPreview'),
    ),
  )
})

test('requires a replacement host handshake after the injected crash', async () => {
  const scheduler = createManualScheduler()
  const events = []
  const first = new FakeUtilityChild()
  const second = new FakeUtilityChild((message) => {
    if (message.command?.type === 'stopPreview') {
      second.emit('message', {
        type: 'reply',
        requestId: message.requestId,
        ok: true,
      })
      return
    }
    if (message.command?.type === 'shutdown') {
      second.emit('message', {
        type: 'reply',
        requestId: message.requestId,
        ok: true,
      })
      second.emit('exit', 0)
    }
  })
  const children = [first, second]
  const context = smokeHost.createSmokeContext({
    manifest,
    utilityRoot: path.join('C:', 'utility'),
    nativeRoot: path.join('C:', 'native'),
    utilityProcess: {
      fork() {
        return children.shift()
      },
    },
    utilityEnvironment: {},
    diagnosticRoot: null,
    timeoutMs: 1_000,
    setTimeoutFn: scheduler.setTimeout,
    clearTimeoutFn: scheduler.clearTimeout,
    NativeRuntimeSupervisor,
    observe(entry) {
      events.push(entry)
    },
  })

  const pending = smokeHost.smokeRuntime(
    context,
    'media',
    'media-host.cjs',
    'syrnike_media.node',
    true,
  )
  first.emit('message', createReadyMessage('media'))
  await new Promise(setImmediate)
  assert.equal(first.killCalls, 1)
  first.emit('exit', 1)
  scheduler.flushNext()
  second.emit('message', createReadyMessage('media'))

  await pending
  assert.equal(
    events.filter((entry) => entry.event === 'fork').length,
    2,
  )
  assert.ok(
    events.some(
      (entry) =>
        entry.event === 'message' &&
        entry.phase === 'restart_handshake' &&
        entry.detail.includes('ready'),
    ),
  )
  assert.ok(
    events.some(
      (entry) =>
        entry.direction === 'supervisor' &&
        entry.detail === 'ready,restart=1,epoch=2',
    ),
  )
})

function createTestContext({ child, events, scheduler }) {
  return smokeHost.createSmokeContext({
    manifest,
    utilityRoot: path.join('C:', 'utility'),
    nativeRoot: path.join('C:', 'native'),
    utilityProcess: {
      fork() {
        return child
      },
    },
    utilityEnvironment: {},
    diagnosticRoot: null,
    timeoutMs: 25,
    setTimeoutFn: scheduler.setTimeout,
    clearTimeoutFn: scheduler.clearTimeout,
    NativeRuntimeSupervisor,
    observe(entry) {
      events.push(entry)
    },
  })
}

function createReadyMessage(runtime) {
  return {
    type: 'ready',
    runtime,
    contractVersion: manifest.contractVersion,
    build: {
      commit: manifest.commitSha,
      napi: String(manifest.napiVersion),
      livekit: manifest.liveKitVersion,
    },
    capabilities: smokeHost.requiredCapabilities(runtime),
  }
}

function createManualScheduler() {
  let nextId = 1
  const pending = new Map()
  return {
    setTimeout(callback, delay = 0) {
      const id = nextId++
      pending.set(id, { callback, delay })
      return id
    },
    clearTimeout(id) {
      pending.delete(id)
    },
    flush() {
      for (const [id, task] of [...pending.entries()]) {
        pending.delete(id)
        task.callback()
      }
    },
    flushNext() {
      const next = [...pending.entries()].sort(
        ([leftId, left], [rightId, right]) =>
          left.delay - right.delay || leftId - rightId,
      )[0]
      if (!next) return
      pending.delete(next[0])
      next[1].callback()
    },
  }
}

class FakeUtilityChild extends EventEmitter {
  constructor(onPostMessage) {
    super()
    this.onPostMessage = onPostMessage
    this.killCalls = 0
  }

  postMessage(message) {
    this.onPostMessage?.(message)
  }

  kill() {
    this.killCalls += 1
  }
}

test('native quarantine smoke waits for close and joins split stdout', async () => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => {}
  let invocation
  const pending = smokeHost.smokeNativeQuarantineShutdown({
    path,
    nativeRoot: path.resolve('native-test-root'),
    timeoutMs: 1_000,
    setTimeoutFn: setTimeout,
    clearTimeoutFn: clearTimeout,
    spawn(executable, args, options) {
      invocation = { executable, args, options }
      return child
    },
  })

  assert.equal(invocation.executable, process.execPath)
  assert.match(invocation.args[0], /smoke-quarantine-shutdown-host\.cjs$/)
  assert.equal(
    invocation.options.env.SYRNIKE_NATIVE_BLOCK_MICROPHONE_OPERATION_ONCE,
    '1',
  )
  assert.equal(
    invocation.options.env.SYRNIKE_NATIVE_FAIL_MEDIA_QUARANTINE_LAUNCH_ONCE,
    '1',
  )
  assert.equal(
    invocation.options.env.SYRNIKE_NATIVE_OBSERVE_MEDIA_QUARANTINE_CLEANUP,
    '1',
  )
  let completed = false
  pending.then(() => {
    completed = true
  })
  child.stdout.emit('data', Buffer.from('native-quarantine-launch-'))
  child.stdout.emit('data', Buffer.from('retry-ok\n'))
  child.emit('exit', 0)
  await new Promise(setImmediate)
  assert.equal(completed, false)
  child.emit('close', 0)
  await pending
})

test('native quarantine smoke rejects close without completion marker', async () => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => {}
  const pending = smokeHost.smokeNativeQuarantineShutdown({
    path,
    nativeRoot: path.resolve('native-test-root'),
    timeoutMs: 1_000,
    setTimeoutFn: setTimeout,
    clearTimeoutFn: clearTimeout,
    spawn() {
      return child
    },
  })

  child.stdout.emit('data', Buffer.from('cleanup-still-pending\n'))
  child.emit('close', 0)
  await assert.rejects(
    pending,
    /Native quarantine smoke closed with code 0/,
  )
})
