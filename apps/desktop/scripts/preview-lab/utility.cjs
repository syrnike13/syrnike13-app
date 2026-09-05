const native = require(process.env.PREVIEW_LAB_ADDON)
const port = process.parentPort
native.start(process.env.LIVEKIT_URL, process.env.LIVEKIT_PUBLISHER_TOKEN, 'preview-lab', process.env.PREVIEW_LAB_SCENARIO)
native.demand(1, true)
port.on('message', ({ data }) => {
  if (data.type === 'release') port.postMessage({ ...data,
    type: 'released', accepted: native.release(data.generation, data.sequence, data.slot) })
  else if (data.type === 'demand') native.demand(data.revision, data.enabled)
  else if (data.type === 'budget') native.budget(data.bytes)
  else if (data.type === 'stop') native.stop()
  else if (data.type === 'metrics') port.postMessage({ type: 'metrics', metrics: native.snapshot() })
})
setInterval(() => {
  try {
    // Poll even while disabled/stopping: pending GPU copies must retire safely.
    const frame = native.take()
    if (frame) port.postMessage({ type: 'frame', frame })
  } catch (error) { port.postMessage({ type: 'failure', message: error.message }) }
}, 8)
