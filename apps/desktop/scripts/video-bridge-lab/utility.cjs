const native = require(process.env.VIDEO_BRIDGE_ADDON)
const port = process.parentPort
const remote = process.env.VIDEO_LAB_REMOTE === '1'
let generation = remote ? 0 : native.begin()
if (remote) native.startRemote(process.env.LIVEKIT_URL, process.env.LIVEKIT_OBSERVER_TOKEN,
  process.env.VIDEO_LAB_ROOM, 'viewer', 'publisher', 'contract-probe')
let sequence = 0
let running = true
port.on('message', ({ data }) => {
  if (data.type === 'release') {
    port.postMessage({ type: 'released', generation: data.generation, sequence: data.sequence, slot: data.slot,
      accepted: native.release(data.generation, data.sequence, data.slot) })
  } else if (data.type === 'generation') {
    generation = native.begin()
    port.postMessage({ type: 'generation', generation })
  } else if (data.type === 'demand' && remote) {
    native.demandRemote(data.enabled)
    if (native.injectLateFrame()) port.postMessage({ type: 'failure', message: 'Late decoded frame accepted' })
  }
  else if (data.type === 'metrics') port.postMessage({ type: 'metrics', metrics: native.snapshot() })
  else if (data.type === 'stop') running = false
})
setInterval(() => {
  if (!running) return
  try {
    const lease = remote ? native.takeRemote() : native.pattern(generation, ++sequence, 1920, 1080)
    const currentGeneration = native.generation()
    if (currentGeneration !== generation) {
      generation = currentGeneration
      port.postMessage({ type: 'generation', generation })
    }
    if (lease) port.postMessage({ type: 'frame', lease })
  } catch (error) {
    running = false
    port.postMessage({ type: 'failure', message: error.message })
  }
}, 16)
port.postMessage({ type: 'ready' })
