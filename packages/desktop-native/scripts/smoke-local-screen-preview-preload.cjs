const { ipcRenderer, sharedTexture } = require('electron')

const canvas = document.createElement('canvas')
canvas.width = 64
canvas.height = 36
const context = canvas.getContext('2d', { alpha: false })
if (!context) throw new Error('2D canvas context is unavailable')

sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, metadata) => {
  let frame = null
  try {
    frame = importedSharedTexture.getVideoFrame()
    context.drawImage(frame, 0, 0, canvas.width, canvas.height)
    const bytes = context.getImageData(0, 0, canvas.width, canvas.height).data
    let rgbChecksum = 0
    for (let index = 0; index < bytes.length; index += 4) {
      rgbChecksum = (rgbChecksum + bytes[index] + bytes[index + 1] + bytes[index + 2]) >>> 0
    }
    ipcRenderer.send('syrnike-preview-smoke-frame', {
      width: frame.codedWidth,
      height: frame.codedHeight,
      sequence: metadata.sequence,
      rgbChecksum,
    })
  } catch (error) {
    ipcRenderer.send(
      'syrnike-preview-smoke-error',
      error instanceof Error ? error.message : String(error),
    )
  } finally {
    frame?.close()
    importedSharedTexture.release()
  }
})
