const { spawn } = require('node:child_process')
const { createRequire } = require('node:module')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const desktopRequire = createRequire(
  path.join(repoRoot, 'apps', 'desktop', 'package.json'),
)
const electronPath = desktopRequire('electron')
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'syrnike-crashpad-'))
const crashRoot = path.join(probeRoot, 'Crashpad')
fs.mkdirSync(crashRoot, { recursive: true })

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

async function run() {
  try {
    const exitCode = await runCrasher()
    if (exitCode === 0) {
      throw new Error('Crashpad probe process exited without crashing')
    }
    const dump = await waitForMinidump(crashRoot)
    const bytes = fs.statSync(dump).size
    if (bytes <= 0) throw new Error('Crashpad minidump is empty')
    console.info(
      `[desktop-native] Crashpad captured minidump (${bytes} bytes)`,
    )
  } catch (error) {
    console.error(
      `[desktop-native] Crashpad probe directory: ${probeRoot}`,
      listFiles(probeRoot),
    )
    throw error
  } finally {
    const temporaryRoot = path.resolve(os.tmpdir())
    const resolvedProbeRoot = path.resolve(probeRoot)
    if (
      process.env.SYRNIKE_KEEP_CRASHPAD_PROBE !== '1' &&
      resolvedProbeRoot.startsWith(`${temporaryRoot}${path.sep}`) &&
      path.basename(resolvedProbeRoot).startsWith('syrnike-crashpad-')
    ) {
      fs.rmSync(resolvedProbeRoot, { recursive: true, force: true })
    }
  }
}

function runCrasher() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      electronPath,
      [path.join(__dirname, 'smoke-crashpad-crasher.cjs')],
      {
        env: {
          ...process.env,
          SYRNIKE_CRASHPAD_PROBE_ROOT: crashRoot,
        },
        stdio: 'ignore',
        windowsHide: true,
      },
    )
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('Crashpad probe process did not exit'))
    }, 10_000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      resolve(code)
    })
  })
}

async function waitForMinidump(directory) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const dump = findMinidump(directory)
    if (dump) return dump
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Crashpad did not create a minidump')
}

function findMinidump(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      const nested = findMinidump(entryPath)
      if (nested) return nested
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.dmp')) {
      return entryPath
    }
  }
  return null
}

function listFiles(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    return entry.isDirectory()
      ? listFiles(entryPath)
      : [{ path: entryPath, bytes: fs.statSync(entryPath).size }]
  })
}
