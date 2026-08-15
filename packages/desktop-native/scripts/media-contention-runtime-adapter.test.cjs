const assert = require('node:assert/strict')
const test = require('node:test')

const {
  CONTENTION_PROTOCOL_VERSION,
  MAXIMUM_PROTOCOL_REQUESTS,
  ContentionNativeRuntimeAdapter,
  scheduleAfterProbeRetirement,
} = require('./media-contention-runtime-adapter.cjs')

function harness() {
  const messages = []
  const writes = []
  const scheduled = []
  const timeouts = []
  const child = {
    pid: 86,
    killCount: 0,
    kill() { this.killCount += 1 },
  }
  const adapter = new ContentionNativeRuntimeAdapter({
    child,
    hostEpoch: 2,
    contractVersion: 10,
    write: (_child, command) => writes.push(command),
    scheduleTimeout: (callback, delayMs) => {
      scheduled.push({ callback, delayMs })
      return scheduled.length
    },
    onGracefulShutdownTimeout: () => timeouts.push(child.pid),
  })
  adapter.start({ onMessage: (message) => messages.push(message) })
  return { adapter, child, messages, scheduled, timeouts, writes }
}

test('routes a versioned exact renderer-fence release and acknowledgement', () => {
  const h = harness()
  assert.equal(h.adapter.handleProtocol('RUNTIME_READY', {
    protocolVersion: CONTENTION_PROTOCOL_VERSION,
  }), true)
  h.adapter.postMessage({
    requestId: 'media-7-uuid',
    command: { type: 'releaseRemoteVideoFrame', sequence: 19 },
  })
  assert.deepEqual(h.writes, ['V1 RELEASE_REMOTE 19 1'])
  assert.equal(h.adapter.handleProtocol('RELEASE_ACK', {
    protocolVersion: CONTENTION_PROTOCOL_VERSION,
    requestId: 1,
    released: true,
  }), true)
  assert.equal(h.messages.at(-1).requestId, 'media-7-uuid')
})

test('arms the next GPU query only through a bounded first-held handshake', async () => {
  const h = harness()
  const armed = h.adapter.armGpuAfterHeld()

  assert.deepEqual(h.writes, ['V1 ARM_GPU_AFTER_HELD 1'])
  assert.equal(h.adapter.handleProtocol('GPU_FAULT_ARMED', {
    protocolVersion: CONTENTION_PROTOCOL_VERSION,
    requestId: 1,
    rendererLeases: 1,
    frameSequence: 19,
  }), true)
  assert.deepEqual(await armed, {
    rendererLeases: 1,
    frameSequence: 19,
  })
})

test('arms four audio recovery samples only after the final runtime recovery', async () => {
  const h = harness()
  const armed = h.adapter.armAudioRecovery()

  assert.deepEqual(h.writes, ['V1 ARM_AUDIO_RECOVERY 1'])
  assert.equal(h.adapter.handleProtocol('AUDIO_RECOVERY_ARMED', {
    protocolVersion: CONTENTION_PROTOCOL_VERSION,
    requestId: 1,
  }), true)
  await armed
  assert.equal(h.adapter.pendingProtocolRequests, 0)
})

test('withholds one attempt and retry around a host-epoch voice probe', () => {
  const h = harness()
  assert.equal(h.adapter.injectReleaseTimeout(), true)
  h.adapter.postMessage({
    requestId: '1',
    command: { type: 'releaseRemoteVideoFrame', sequence: 20 },
  })
  h.adapter.postMessage({
    requestId: '2',
    command: { type: 'probeVoiceControl' },
  })
  h.adapter.postMessage({
    requestId: '3',
    command: { type: 'releaseRemoteVideoFrame', sequence: 20 },
  })
  assert.deepEqual(h.writes, [])
  assert.deepEqual(h.messages.at(-1).result, {
    state: 'busy',
    hostEpoch: 2,
    queueDepth: 1,
    queueCapacity: 64,
  })
  h.adapter.kill()
  h.adapter.kill()
  assert.deepEqual(h.writes, ['V1 FINISH 1'])
  assert.equal(h.child.killCount, 0)
  h.scheduled[0].callback()
  assert.equal(h.child.killCount, 1)
  assert.deepEqual(h.timeouts, [86])
})

test('routes bounded demand removal through the same versioned host epoch', () => {
  const h = harness()
  h.adapter.postMessage({
    requestId: 'demand-1',
    command: {
      type: 'setRemoteVideoDemand',
      sessionId: 'contention-session',
      generation: 7,
      trackId: 'contention-remote',
      demanded: false,
    },
  })
  assert.deepEqual(h.writes, ['V1 REMOVE_DEMAND 1'])
  assert.equal(h.adapter.handleProtocol('DEMAND_REMOVED', {
    protocolVersion: CONTENTION_PROTOCOL_VERSION,
    requestId: 1,
  }), true)
  assert.deepEqual(h.messages.at(-1), {
    type: 'reply',
    requestId: 'demand-1',
    ok: true,
    result: { demanded: false },
  })
})

test('uses the versioned child finish seam for owned supervisor shutdown', () => {
  const h = harness()
  h.adapter.postMessage({
    requestId: 'shutdown-1',
    command: { type: 'shutdown' },
  })
  assert.deepEqual(h.writes, ['V1 FINISH 1'])
  assert.equal(h.adapter.handleProtocol('FINISH_ACK', {
    protocolVersion: CONTENTION_PROTOCOL_VERSION,
    requestId: 1,
  }), true)
  assert.deepEqual(h.messages.at(-1), {
    type: 'reply',
    requestId: 'shutdown-1',
    ok: true,
    result: { accepted: true },
  })
})

test('an acknowledged finish gets bounded graceful exit time before force kill', () => {
  const scheduled = []
  const timeouts = []
  const child = {
    pid: 87,
    killCount: 0,
    kill() { this.killCount += 1 },
  }
  const adapter = new ContentionNativeRuntimeAdapter({
    child,
    hostEpoch: 3,
    contractVersion: 10,
    write: () => true,
    gracefulShutdownTimeoutMs: 8_000,
    scheduleTimeout: (callback, delayMs) => {
      scheduled.push({ callback, delayMs })
      return scheduled.length
    },
    onGracefulShutdownTimeout: () => timeouts.push(child.pid),
  })
  adapter.start({ onMessage: () => undefined })
  adapter.postMessage({
    requestId: 'shutdown-1',
    command: { type: 'shutdown' },
  })
  adapter.handleProtocol('FINISH_ACK', {
    protocolVersion: CONTENTION_PROTOCOL_VERSION,
    requestId: 1,
  })

  adapter.kill()
  assert.equal(child.killCount, 0)
  assert.equal(scheduled[0].delayMs, 8_000)
  scheduled[0].callback()
  assert.equal(child.killCount, 1)
  assert.deepEqual(timeouts, [87])
})

test('does not start a replacement host before the retired probe exits', async () => {
  const scheduled = []
  let releaseRetirement
  const retired = new Promise((resolve) => { releaseRetirement = resolve })
  let replacementStarts = 0
  scheduleAfterProbeRetirement(
    () => { replacementStarts += 1 },
    100,
    retired,
    (callback, delayMs) => {
      scheduled.push({ callback, delayMs })
      return scheduled.length
    },
  )

  assert.equal(scheduled[0].delayMs, 100)
  scheduled[0].callback()
  await Promise.resolve()
  assert.equal(replacementStarts, 0)
  releaseRetirement()
  await Promise.resolve()
  assert.equal(replacementStarts, 1)
})

test('fails the next request explicitly when the child protocol map is full', () => {
  const h = harness()
  for (let index = 0; index < MAXIMUM_PROTOCOL_REQUESTS; index += 1) {
    h.adapter.postMessage({
      requestId: `release-${index}`,
      command: { type: 'releaseRemoteVideoFrame', sequence: index + 1 },
    })
  }
  h.adapter.postMessage({
    requestId: 'overflow',
    command: { type: 'releaseRemoteVideoFrame', sequence: 10_000 },
  })
  assert.equal(h.writes.length, MAXIMUM_PROTOCOL_REQUESTS)
  assert.equal(h.messages.at(-1).requestId, 'overflow')
  assert.equal(h.messages.at(-1).error.code, 'queue_full')
})

test('rejects an unversioned or future child acknowledgement', () => {
  const h = harness()
  assert.equal(h.adapter.handleProtocol('RELEASE_ACK', {
    protocolVersion: CONTENTION_PROTOCOL_VERSION + 1,
    requestId: 1,
  }), false)
  assert.deepEqual(h.messages, [])
})
