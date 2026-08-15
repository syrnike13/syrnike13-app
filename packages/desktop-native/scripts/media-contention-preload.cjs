const { ipcRenderer, sharedTexture } = require('electron')
const {
  releaseAfterRendererFence,
} = require('./media-contention-renderer-fence.cjs')

const canvases = new Map()

sharedTexture.setSharedTextureReceiver(({ importedSharedTexture }, metadata) => {
  let frame = null
  try {
    frame = importedSharedTexture.getVideoFrame()
    const canvas = canvasFor(metadata.kind)
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('2D canvas context is unavailable')
    context.drawImage(frame, 0, 0, canvas.width, canvas.height)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    let rgbChecksum = 0
    for (let index = 0; index < pixels.length; index += 4) {
      rgbChecksum = (
        rgbChecksum + pixels[index] + pixels[index + 1] + pixels[index + 2]
      ) >>> 0
    }
    ipcRenderer.send('syrnike-contention-presented', {
      kind: metadata.kind,
      sequence: metadata.sequence,
      runtimeEpoch: metadata.runtimeEpoch,
      rendererEpoch: metadata.rendererEpoch,
      presentedAtMs: Date.now(),
      width: frame.codedWidth,
      height: frame.codedHeight,
      rgbChecksum,
    })
  } catch (error) {
    ipcRenderer.send(
      'syrnike-contention-renderer-error',
      error instanceof Error ? error.message : String(error),
    )
  } finally {
    frame?.close()
    releaseAfterRendererFence(importedSharedTexture, metadata.holdMs)
  }
})

let expectedTick = performance.now() + 10
let samples = []
let maximumMs = 0
setInterval(() => {
  const now = performance.now()
  const delayMs = Math.max(0, now - expectedTick)
  expectedTick = now + 10
  samples.push(delayMs)
  maximumMs = Math.max(maximumMs, delayMs)
  if (samples.length < 100) return
  const sorted = [...samples].sort((left, right) => left - right)
  ipcRenderer.send('syrnike-contention-renderer-loop', {
    p95Ms: sorted[Math.floor((sorted.length - 1) * 0.95)],
    p99Ms: sorted[Math.floor((sorted.length - 1) * 0.99)],
    maximumMs,
  })
  samples = []
  maximumMs = 0
}, 10)

function canvasFor(kind) {
  let canvas = canvases.get(kind)
  if (canvas) return canvas
  canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 36
  document.body.append(canvas)
  canvases.set(kind, canvas)
  return canvas
}
