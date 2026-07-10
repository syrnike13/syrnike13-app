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

const manifest = {
  appVersion: '0.0.0-test',
  releaseChannel: 'test',
  contractVersion: 2,
  liveKitVersion: '1.2.3-test',
  commitSha: 'abc123',
  napiVersion: 8,
}

test('reports observable control traffic when the native request hangs', async () => {
  const scheduler = createManualScheduler()
  const events = []
  const child = new FakeUtilityChild((message) => {
    if (message.requestId !== 'media-smoke-command') return
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
  scheduler.flush()

  await assert.rejects(
    pending,
    /Timed out during media utility host command; observed .*host:postMessage:media:command:request,request=media-smoke-command,command=stopPreview.*child:message:media:command:control,control=native_request_pending/,
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
    if (message.requestId !== 'media-smoke-command') return
    child.emit('message', {
      type: 'control',
      control: { type: 'native_request_failed' },
    })
    child.emit('message', {
      type: 'reply',
      requestId: message.requestId,
      ok: false,
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
    /media DLL rejected the smoke command; observed .*child:message:media:command:control,control=native_request_failed.*child:message:media:command:reply,request=media-smoke-command,error/,
  )
  assert.equal(child.killCalls, 1)
  assert.ok(
    events.some(
      (entry) =>
        entry.direction === 'host' &&
        entry.event === 'postMessage' &&
        entry.detail === 'request,request=media-smoke-command,command=stopPreview',
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
    setTimeout(callback) {
      const id = nextId++
      pending.set(id, callback)
      return id
    },
    clearTimeout(id) {
      pending.delete(id)
    },
    flush() {
      for (const [id, callback] of [...pending.entries()]) {
        pending.delete(id)
        callback()
      }
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
