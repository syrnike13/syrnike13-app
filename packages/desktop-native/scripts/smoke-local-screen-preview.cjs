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
const expectedFrames = 30
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

  const rendererFrames = new Set()
  const releasedFrames = new Set()
  let childExited = false

  const maybeFinish = () => {
    if (
      finished ||
      rendererFrames.size !== expectedFrames ||
      releasedFrames.size !== expectedFrames ||
      !childExited
    ) return
    finished = true
    console.log(
      `ASSERT electron_local_screen_preview dimensions=${expectedWidth}x${expectedHeight} ` +
      `frames=${expectedFrames} import=pass renderer_canvas=pass ` +
      'content_nonzero=pass references_released=pass',
    )
    app.exit(0)
  }

  ipcMain.on('syrnike-preview-smoke-frame', (_event, dimensions) => {
    if (dimensions?.width !== expectedWidth || dimensions?.height !== expectedHeight) {
      fail(`renderer VideoFrame dimensions mismatch: ${JSON.stringify(dimensions)}`)
      return
    }
    if (!Number.isSafeInteger(dimensions.sequence)) {
      fail(`renderer VideoFrame sequence is invalid: ${JSON.stringify(dimensions)}`)
      return
    }
    if (!Number.isSafeInteger(dimensions.rgbChecksum) || dimensions.rgbChecksum === 0) {
      fail(`renderer canvas has no visible RGB content: ${JSON.stringify(dimensions)}`)
      return
    }
    rendererFrames.add(dimensions.sequence)
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
      String(expectedFrames),
      '--capture',
      'screen:1',
      String(process.pid),
    ],
    { windowsHide: true },
  )
  let stdout = ''
  const importedFrames = new Set()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', async (chunk) => {
    stdout += chunk
    process.stdout.write(chunk)
    const matches = [...stdout.matchAll(
      /EXTERNAL_PREVIEW nt_handle=(\d+) sequence=(\d+) width=(\d+) height=(\d+)/g,
    )]
    const match = matches.find((candidate) => !importedFrames.has(Number(candidate[2])))
    if (!match) return
    try {
      const sequence = Number(match[2])
      importedFrames.add(sequence)
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
          releasedFrames.add(sequence)
          child.stdin.write(`RELEASE ${sequence}\n`)
          maybeFinish()
        },
      })
      try {
        await sharedTexture.sendSharedTexture(
          { frame: window.webContents.mainFrame, importedSharedTexture: texture },
          { smoke: true, sequence },
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
