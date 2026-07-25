/**
 * Smoke test: quarantine shutdown with blocked actor operation
 *
 * Verifies that detached thread cleanup in quarantineSubsystemShutdown handles
 * actors stuck in blocking operations without crashing or leaking threads.
 *
 * Scenario:
 * 1. Create runtime with injected long-running microphone operation
 * 2. Trigger shutdown with tight deadline (500ms)
 * 3. Verify process exits cleanly < 2s, no crashes
 */

const { parentPort } = require('node:worker_threads')
const path = require('node:path')
const { createRequire } = require('node:module')

if (!parentPort) {
  console.error('smoke-quarantine-shutdown-host must run as a worker')
  process.exit(1)
}

const nativeModulePath = process.env.SYRNIKE_NATIVE_MODULE_PATH
if (!nativeModulePath) {
  console.error('SYRNIKE_NATIVE_MODULE_PATH not set')
  process.exit(1)
}

const require2 = createRequire(path.resolve(process.cwd(), 'quarantine-host.cjs'))
const addon = require2(nativeModulePath)

const startTime = Date.now()
let shutdownRequested = false

// Inject a hook that makes microphone operations artificially slow
let beforeMicrophoneOperationCount = 0
const beforeMicrophoneOperation = (command) => {
  beforeMicrophoneOperationCount++
  // Simulate a slow device probe or ensureCapture (5 seconds)
  if (command.type === 'probeMicrophoneActor' || command.type === 'configureMicrophone') {
    const blockUntil = Date.now() + 5000
    while (Date.now() < blockUntil && !shutdownRequested) {
      // Busy wait to simulate blocking native operation
    }
  }
}

function emit(event) {
  if (event.type === 'ready') {
    parentPort.postMessage({
      type: 'ready',
      capabilities: event.capabilities,
      timestamp: Date.now() - startTime,
    })
  } else if (event.type === 'reply') {
    parentPort.postMessage({
      type: 'reply',
      requestId: event.requestId,
      ok: event.ok,
      timestamp: Date.now() - startTime,
    })
  } else if (event.type === 'runtimeError') {
    parentPort.postMessage({
      type: 'runtimeError',
      error: event.error,
      timestamp: Date.now() - startTime,
    })
  }
}

const factory = addon.createMediaRuntimeFactory()

// Create runtime with hooks for slow operations and early shutdown detection
const runtime = factory(emit, {
  beforeMicrophoneOperation,
  beforeVoiceShutdown: () => {
    shutdownRequested = true
  },
})

parentPort.on('message', (message) => {
  if (message.type === 'dispatch') {
    try {
      runtime.dispatch(message.command)
    } catch (error) {
      parentPort.postMessage({
        type: 'dispatchError',
        requestId: message.command.requestId,
        message: error.message,
        timestamp: Date.now() - startTime,
      })
    }
  } else if (message.type === 'shutdown') {
    shutdownRequested = true
    const shutdownStart = Date.now()
    try {
      runtime.shutdown()
      parentPort.postMessage({
        type: 'shutdownComplete',
        duration: Date.now() - shutdownStart,
        microphoneOpsProcessed: beforeMicrophoneOperationCount,
        timestamp: Date.now() - startTime,
      })
    } catch (error) {
      parentPort.postMessage({
        type: 'shutdownError',
        message: error.message,
        duration: Date.now() - shutdownStart,
        timestamp: Date.now() - startTime,
      })
    }
  }
})

// Signal ready for commands
parentPort.postMessage({ type: 'hostReady', timestamp: Date.now() - startTime })
