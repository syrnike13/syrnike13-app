const { ipcRenderer, sharedTexture } = require('electron')

sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }) => {
  let frame = null
  try {
    frame = importedSharedTexture.getVideoFrame()
    const bytes = new Uint8Array(frame.allocationSize({ format: 'BGRA' }))
    await frame.copyTo(bytes, { format: 'BGRA' })
    let rgbChecksum = 0
    for (let index = 0; index < bytes.length; index += 4) {
      rgbChecksum = (rgbChecksum + bytes[index] + bytes[index + 1] + bytes[index + 2]) >>> 0
    }
    ipcRenderer.send('syrnike-preview-smoke-frame', {
      width: frame.codedWidth,
      height: frame.codedHeight,
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
