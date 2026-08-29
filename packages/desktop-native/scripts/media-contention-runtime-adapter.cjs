const CONTENTION_PROTOCOL_VERSION = 1
const MAXIMUM_PROTOCOL_REQUESTS = 64

function scheduleAfterProbeRetirement(
  callback,
  delayMs,
  retirement,
  scheduleTimeout = setTimeout,
) {
  return scheduleTimeout(() => {
    void Promise.resolve(retirement).then(() => {
      scheduleTimeout(callback, delayMs)
    })
  }, 0)
}

class ContentionNativeRuntimeAdapter {
  constructor(options) {
    this.child = options.child
    this.pid = options.child.pid
    this.hostEpoch = options.hostEpoch
    this.contractVersion = options.contractVersion
    this.write = options.write
    this.protocolRequestTimeoutMs = options.protocolRequestTimeoutMs ?? 2_500
    this.onKilled = options.onKilled ?? (() => undefined)
    this.onGracefulShutdownTimeout =
      options.onGracefulShutdownTimeout ?? (() => undefined)
    this.gracefulShutdownTimeoutMs =
      options.gracefulShutdownTimeoutMs ?? 8_000
    this.scheduleTimeout = options.scheduleTimeout ?? setTimeout
    this.clearScheduledTimeout = options.clearScheduledTimeout ?? clearTimeout
    this.callbacks = null
    this.killed = false
    this.releaseTimeoutStage = 'disabled'
    this.nextProtocolRequest = 0
    this.protocolRequests = new Map()
    this.exitReported = false
    this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve })
    this.finishAcknowledged = false
    this.gracefulShutdownTimer = null
  }

  start(callbacks) {
    this.callbacks = callbacks
    if (typeof this.child.once === 'function') {
      this.child.once('exit', (code, signal) => {
        this.resolveExit()
        if (this.gracefulShutdownTimer !== null) {
          this.clearScheduledTimeout(this.gracefulShutdownTimer)
          this.gracefulShutdownTimer = null
        }
        if (this.exitReported) return
        this.exitReported = true
        this.callbacks?.onExit?.({ code, signal, terminationSource: 'exit' })
      })
      this.child.once('error', () => {
        this.resolveExit()
        if (this.exitReported) return
        this.exitReported = true
        this.callbacks?.onExit?.({ code: null, terminationSource: 'error' })
      })
    }
  }

  waitForExit() {
    return this.exitPromise
  }

  postMessage(message) {
    const { command, requestId } = message
    if (command.type === 'probeVoiceControl') {
      if (this.releaseTimeoutStage === 'first-withheld') {
        this.releaseTimeoutStage = 'probe-replied'
      }
      this.callbacks?.onMessage({
        type: 'reply',
        requestId,
        ok: true,
        result: {
          state: 'busy',
          hostEpoch: this.hostEpoch,
          queueDepth: this.releaseTimeoutStage === 'disabled' ? 0 : 1,
          queueCapacity: 64,
        },
      })
      return
    }
    const isRemoteRelease = command.type === 'releaseRemoteVideoFrame'
    const isCameraRelease = command.type === 'releaseLocalCameraPreviewFrame'
    const isRelease = isRemoteRelease || isCameraRelease
    const isDemandRemoval = command.type === 'setRemoteVideoDemand' &&
      command.demanded === false
    const isShutdown = command.type === 'shutdown'
    if (!isRelease && !isDemandRemoval && !isShutdown) {
      this.callbacks?.onMessage({
        type: 'reply',
        requestId,
        ok: false,
        error: {
          code: 'invalid_command',
          message: `contention adapter does not route ${command.type}`,
          retryable: false,
        },
      })
      return
    }
    if (isRemoteRelease && this.releaseTimeoutStage === 'armed') {
      this.releaseTimeoutStage = 'first-withheld'
      return
    }
    if (isRemoteRelease && this.releaseTimeoutStage === 'probe-replied') {
      this.releaseTimeoutStage = 'retry-withheld'
      return
    }
    if (this.protocolRequests.size >= MAXIMUM_PROTOCOL_REQUESTS) {
      this.callbacks?.onMessage({
        type: 'reply',
        requestId,
        ok: false,
        error: {
          code: 'queue_full',
          message: 'contention child protocol request budget is full',
          retryable: true,
        },
      })
      return
    }
    const protocolRequestId = ++this.nextProtocolRequest
    this.protocolRequests.set(protocolRequestId, {
      requestId,
      kind: isRemoteRelease
        ? 'remote-release'
        : isCameraRelease
          ? 'camera-release'
        : isDemandRemoval
          ? 'demand-removal'
          : 'shutdown',
    })
    this.write(
      this.child,
      isRemoteRelease
        ? `V${CONTENTION_PROTOCOL_VERSION} RELEASE_REMOTE ` +
          `${command.sequence} ${protocolRequestId}`
        : isCameraRelease
          ? `V${CONTENTION_PROTOCOL_VERSION} RELEASE_CAMERA ` +
            `${command.sequence} ${protocolRequestId}`
        : isDemandRemoval
          ? `V${CONTENTION_PROTOCOL_VERSION} REMOVE_DEMAND ${protocolRequestId}`
          : `V${CONTENTION_PROTOCOL_VERSION} FINISH ${protocolRequestId}`,
    )
  }

  kill() {
    if (this.killed) return
    this.killed = true
    for (const pending of this.protocolRequests.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject?.(new Error('contention child exited before acknowledgement'))
    }
    this.protocolRequests.clear()
    this.onKilled(this)
    if (!this.finishAcknowledged) {
      this.write(
        this.child,
        `V${CONTENTION_PROTOCOL_VERSION} FINISH ${++this.nextProtocolRequest}`,
      )
    }
    this.gracefulShutdownTimer = this.scheduleTimeout(() => {
      this.gracefulShutdownTimer = null
      this.onGracefulShutdownTimeout(this)
      this.child.kill()
    }, this.gracefulShutdownTimeoutMs)
    this.gracefulShutdownTimer?.unref?.()
  }

  injectReleaseTimeout() {
    if (this.releaseTimeoutStage !== 'disabled') return false
    this.releaseTimeoutStage = 'armed'
    return true
  }

  armGpuAfterHeld() {
    return this.#sendHarnessRequest('gpu-arm', 'ARM_GPU_AFTER_HELD')
  }

  armAudioRecovery() {
    return this.#sendHarnessRequest('audio-arm', 'ARM_AUDIO_RECOVERY')
  }

  get pendingProtocolRequests() {
    return this.protocolRequests.size
  }

  #sendHarnessRequest(kind, command) {
    if (this.protocolRequests.size >= MAXIMUM_PROTOCOL_REQUESTS) {
      return Promise.reject(new Error(
        'contention child protocol request budget is full',
      ))
    }
    const protocolRequestId = ++this.nextProtocolRequest
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.protocolRequests.delete(protocolRequestId)) return
        reject(new Error(`${command} acknowledgement timed out`))
      }, this.protocolRequestTimeoutMs)
      this.protocolRequests.set(protocolRequestId, {
        kind,
        resolve,
        reject,
        timer,
      })
      if (this.write(
        this.child,
        `V${CONTENTION_PROTOCOL_VERSION} ${command} ${protocolRequestId}`,
      ) !== false) return
      clearTimeout(timer)
      this.protocolRequests.delete(protocolRequestId)
      reject(new Error(`${command} could not be written to contention child`))
    })
  }

  handleProtocol(prefix, value) {
    if (value?.protocolVersion !== CONTENTION_PROTOCOL_VERSION) return false
    if (prefix === 'RUNTIME_READY') {
      this.callbacks?.onMessage({
        type: 'ready',
        contractVersion: this.contractVersion,
        runtime: 'media',
        capabilities: ['microphone'],
        build: {},
      })
      return true
    }
    if ((prefix !== 'RELEASE_ACK' && prefix !== 'CAMERA_RELEASE_ACK' &&
      prefix !== 'DEMAND_REMOVED' &&
      prefix !== 'FINISH_ACK' && prefix !== 'GPU_FAULT_ARMED' &&
      prefix !== 'AUDIO_RECOVERY_ARMED') ||
      !Number.isSafeInteger(value.requestId)) {
      return false
    }
    const pending = this.protocolRequests.get(value.requestId)
    if (pending === undefined) return false
    if ((prefix === 'RELEASE_ACK' && pending.kind !== 'remote-release') ||
      (prefix === 'CAMERA_RELEASE_ACK' &&
        pending.kind !== 'camera-release') ||
      (prefix === 'DEMAND_REMOVED' && pending.kind !== 'demand-removal') ||
      (prefix === 'FINISH_ACK' && pending.kind !== 'shutdown') ||
      (prefix === 'GPU_FAULT_ARMED' && pending.kind !== 'gpu-arm') ||
      (prefix === 'AUDIO_RECOVERY_ARMED' && pending.kind !== 'audio-arm')) {
      return false
    }
    if (pending.timer) clearTimeout(pending.timer)
    this.protocolRequests.delete(value.requestId)
    if (prefix === 'FINISH_ACK') this.finishAcknowledged = true
    if (pending.resolve) {
      pending.resolve(prefix === 'GPU_FAULT_ARMED'
        ? {
            rendererLeases: Number(value.rendererLeases) || 0,
            frameSequence: Number(value.frameSequence) || 0,
          }
        : undefined)
      return true
    }
    this.callbacks?.onMessage({
      type: 'reply',
      requestId: pending.requestId,
      ok: true,
      result: prefix === 'RELEASE_ACK' || prefix === 'CAMERA_RELEASE_ACK'
        ? { released: value.released !== false }
        : prefix === 'DEMAND_REMOVED'
          ? { demanded: false }
          : { accepted: true },
    })
    return true
  }
}

module.exports = {
  CONTENTION_PROTOCOL_VERSION,
  MAXIMUM_PROTOCOL_REQUESTS,
  ContentionNativeRuntimeAdapter,
  scheduleAfterProbeRetirement,
}
