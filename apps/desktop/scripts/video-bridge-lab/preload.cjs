const { sharedTexture, ipcRenderer } = require('electron')
let mode = 'normal'
let generation = 0
let hostEpoch = 0
let lastSequence = 0
let presented = 0
let stale = 0
let held = []
const releaseEntry = entry => {
  if (!held.includes(entry)) return
  held = held.filter(value => value !== entry)
  entry.frame.close(); entry.texture.release()
}
const releaseHeld = () => {
  for (const entry of held) { entry.frame.close(); entry.texture.release() }
  held = []
}
ipcRenderer.on('video-lab-mode', (_event, next) => {
  mode = next
  if (mode === 'normal') releaseHeld()
})
ipcRenderer.on('video-lab-generation', (_event, next) => {
  if (next <= generation) return
  generation = next
  lastSequence = 0
  releaseHeld()
  const canvas = document.getElementById('video')
  if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height)
})
sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture: texture }, lease) => {
  const frame = texture.getVideoFrame()
  try {
    if (!Number.isSafeInteger(lease.hostEpoch) || lease.hostEpoch < hostEpoch) { stale++; return }
    if (lease.hostEpoch > hostEpoch) { hostEpoch = lease.hostEpoch; generation = 0; lastSequence = 0; releaseHeld() }
    if (lease.version !== 1 || lease.generation < generation || lease.sequence <= lastSequence) {
      stale++
      return
    }
    generation = lease.generation
    lastSequence = lease.sequence
    if (mode === 'stall') {
      if (held.length >= 4) throw Error('Renderer lease bound exceeded')
      held.push({ frame, texture })
      return
    }
    const canvas = document.getElementById('video')
    canvas.width = frame.codedWidth
    canvas.height = frame.codedHeight
    canvas.getContext('2d').drawImage(frame, 0, 0)
    presented++
    ipcRenderer.send('video-lab-presented', { version: 1, generation, sequence: lastSequence, timestamp: frame.timestamp, ingressUs: lease.ingressUs })
    if (mode === 'slow') {
      const entry = { frame, texture }
      held.push(entry)
      setTimeout(() => releaseEntry(entry), 150)
    }
  } finally {
    if (!held.some(entry => entry.frame === frame)) { frame.close(); texture.release() }
  }
})
window.addEventListener('DOMContentLoaded', () => ipcRenderer.send('video-lab-ready'))
window.addEventListener('beforeunload', releaseHeld)
setInterval(() => ipcRenderer.send('video-lab-renderer-metrics', { presented, stale, held: held.length }), 1000)
