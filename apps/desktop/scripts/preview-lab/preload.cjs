const { sharedTexture, ipcRenderer } = require('electron')
let held = [], mode = 'normal', generation = 0, sequence = 0
function release(entry) { entry.frame.close(); entry.texture.release() }
function clear() { for (const entry of held) release(entry); held = [] }
function draw(entry) {
  const canvas = document.getElementById('video')
  canvas.width = entry.frame.codedWidth; canvas.height = entry.frame.codedHeight
  canvas.getContext('2d').drawImage(entry.frame, 0, 0)
  ipcRenderer.send('preview-presented', { generation: entry.metadata.generation,
    sequence: entry.metadata.sequence, timestamp: entry.metadata.timestamp })
}
ipcRenderer.on('preview-mode', (_event, next) => { mode = next; if (next === 'normal') clear() })
ipcRenderer.on('preview-generation', (_event, next) => {
  if (next <= generation) return
  generation = next; sequence = 0
  clear()
})
sharedTexture.setSharedTextureReceiver(({ importedSharedTexture: texture }, metadata) => {
  const frame = texture.getVideoFrame()
  const entry = { texture, frame, metadata }
  if (metadata.kind !== 'local-preview' || metadata.generation < generation || metadata.sequence <= sequence) {
    release(entry); return
  }
  generation = metadata.generation; sequence = metadata.sequence
  if (mode === 'normal') { draw(entry); release(entry); return }
  if (held.length >= 2) { release(entry); throw Error('Preview renderer capacity exceeded') }
  held.push(entry)
})
setInterval(() => {
  if (mode === 'slow' && held.length) { draw(held.at(-1)); clear() }
  ipcRenderer.send('preview-renderer', { held: held.length, mode })
}, 1000)
window.addEventListener('DOMContentLoaded', () => ipcRenderer.send('preview-ready'))
window.addEventListener('beforeunload', clear)
