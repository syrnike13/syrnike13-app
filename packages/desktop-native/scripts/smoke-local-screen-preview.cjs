const { spawn } = require('node:child_process')
const path = require('node:path')
const {
  app,
  BrowserWindow,
  ipcMain,
  sharedTexture,
} = require('electron')

const expectedWidth = 1280
const expectedHeight = 720
const benchmark = path.join(
  __dirname,
  '..',
  'build',
  'Release',
  'syrnike-native-screen-streaming-benchmark.exe',
)

let finished = false

function fail(error) {
  if (finished) return
  finished = true
  console.error(error instanceof Error ? error.stack : error)
  app.exit(1)
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'smoke-local-screen-preview-preload.cjs'),
      sandbox: false,
    },
  })
  await window.loadURL('data:text/html,<title>native preview smoke</title>')

  let rendererReceived = false
  let allReferencesReleased = false
  let childExited = false

  const maybeFinish = () => {
    if (finished || !rendererReceived || !allReferencesReleased || !childExited) return
    finished = true
    console.log(
      `ASSERT electron_local_screen_preview dimensions=${expectedWidth}x${expectedHeight} ` +
      'import=pass renderer_video_frame=pass content_nonzero=pass references_released=pass',
    )
    app.exit(0)
  }

  ipcMain.once('syrnike-preview-smoke-frame', (_event, dimensions) => {
    if (dimensions?.width !== expectedWidth || dimensions?.height !== expectedHeight) {
      fail(`renderer VideoFrame dimensions mismatch: ${JSON.stringify(dimensions)}`)
      return
    }
    if (!Number.isSafeInteger(dimensions.rgbChecksum) || dimensions.rgbChecksum === 0) {
      fail(`renderer VideoFrame has no visible RGB content: ${JSON.stringify(dimensions)}`)
      return
    }
    rendererReceived = true
    maybeFinish()
  })
  ipcMain.once('syrnike-preview-smoke-error', (_event, message) => fail(message))

  const child = spawn(
    benchmark,
    [
      '1920',
      '1080',
      String(expectedWidth),
      String(expectedHeight),
      '30',
      '--capture',
      'screen:1',
      String(process.pid),
    ],
    { windowsHide: true },
  )
  let stdout = ''
  let imported = false
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', async (chunk) => {
    stdout += chunk
    process.stdout.write(chunk)
    if (imported) return
    const match = stdout.match(
      /EXTERNAL_PREVIEW nt_handle=(\d+) sequence=(\d+) width=(\d+) height=(\d+)/,
    )
    if (!match) return
    imported = true
    try {
      const sequence = match[2]
      const width = Number(match[3])
      const height = Number(match[4])
      if (width !== expectedWidth || height !== expectedHeight) {
        throw new Error(`native preview dimensions mismatch: ${width}x${height}`)
      }
      const ntHandle = Buffer.alloc(8)
      ntHandle.writeBigUInt64LE(BigInt(match[1]))
      const texture = sharedTexture.importSharedTexture({
        textureInfo: {
          pixelFormat: 'bgra',
          codedSize: { width, height },
          visibleRect: { x: 0, y: 0, width, height },
          timestamp: 0,
          handle: { ntHandle },
        },
        allReferencesReleased: () => {
          allReferencesReleased = true
          child.stdin.write(`RELEASE ${sequence}\n`)
          maybeFinish()
        },
      })
      try {
        await sharedTexture.sendSharedTexture(
          { frame: window.webContents.mainFrame, importedSharedTexture: texture },
          { smoke: true },
        )
      } finally {
        texture.release()
      }
    } catch (error) {
      fail(error)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => process.stderr.write(chunk))
  child.on('error', fail)
  child.on('exit', (code) => {
    if (code !== 0) {
      fail(`screen streaming benchmark exited with ${code}`)
      return
    }
    childExited = true
    maybeFinish()
  })

  setTimeout(() => fail('local screen preview smoke timed out'), 30_000).unref()
}).catch(fail)
