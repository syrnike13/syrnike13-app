const listeners = new Set()
const errorListeners = new Set()
const transportListeners = new Set()
let port = null
let currentSnapshot = null
let currentContext = null
let currentError = null
let currentTransport = 'disconnected'

function applyTheme(theme) {
  for (const [key, value] of Object.entries(theme ?? {})) {
    if (key.startsWith('--') && typeof value === 'string') {
      document.documentElement.style.setProperty(key, value)
    }
  }
}

function publishSnapshot(snapshot) {
  currentSnapshot = snapshot
  for (const listener of listeners) listener(snapshot)
}

function publishError(error) {
  currentError = error ?? null
  for (const listener of errorListeners) listener(currentError)
}

function publishTransport(transport) {
  currentTransport = transport ?? 'disconnected'
  for (const listener of transportListeners) listener(currentTransport)
}

window.addEventListener('message', (event) => {
  const message = event.data
  const nextPort = event.ports?.[0]
  if (
    message?.type !== 'syrnike.activity.bootstrap' ||
    message.version !== 1 ||
    !nextPort
  ) {
    return
  }

  port?.close()
  port = nextPort
  currentContext = message.context ?? null
  applyTheme(message.theme)
  publishSnapshot(message.snapshot)
  publishError(message.error)
  publishTransport(message.transport)
  port.onmessage = (portEvent) => {
    const payload = portEvent.data
    if (payload?.type === 'syrnike.activity.snapshot') {
      publishSnapshot(payload.snapshot)
    } else if (payload?.type === 'syrnike.activity.theme') {
      applyTheme(payload.theme)
    } else if (payload?.type === 'syrnike.activity.error') {
      publishError(payload.error)
    } else if (payload?.type === 'syrnike.activity.transport') {
      publishTransport(payload.transport)
    }
  }
  port.start()
})

window.parent.postMessage({ type: 'syrnike.activity.ready', version: 1 }, '*')

window.syrnikeActivity = Object.freeze({
  getContext() {
    return currentContext
  },
  getSnapshot() {
    return currentSnapshot
  },
  subscribe(listener) {
    listeners.add(listener)
    if (currentSnapshot) listener(currentSnapshot)
    return () => listeners.delete(listener)
  },
  getError() {
    return currentError
  },
  subscribeError(listener) {
    errorListeners.add(listener)
    listener(currentError)
    return () => errorListeners.delete(listener)
  },
  getTransport() {
    return currentTransport
  },
  subscribeTransport(listener) {
    transportListeners.add(listener)
    listener(currentTransport)
    return () => transportListeners.delete(listener)
  },
  command(command) {
    port?.postMessage({ type: 'syrnike.activity.command', command })
  },
  close() {
    port?.postMessage({ type: 'syrnike.activity.close' })
  },
})
