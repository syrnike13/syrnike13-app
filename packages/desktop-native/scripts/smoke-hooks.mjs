import { createRequire } from 'node:module'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const repoRoot = path.resolve(packageRoot, '..', '..')
const desktopRoot = path.resolve(repoRoot, 'apps', 'desktop')
const desktopRequire = createRequire(path.resolve(desktopRoot, 'package.json'))
const electronPath = desktopRequire('electron')

const script = String.raw`
  const path = require('node:path')
  ;(async () => {
    for (const kind of ['hotkey', 'overlay']) {
      const addon = require(path.resolve(
        'out/native/win32-x64',
        'syrnike_' + kind + '.node',
      ))
      const info = addon.getRuntimeInfo()
      if (!info.available || info.runtime !== kind) {
        throw new Error('Invalid ' + kind + ' runtime info')
      }
      const factory = kind === 'hotkey'
        ? addon.createHotkeyRuntime
        : addon.createOverlayRuntime
      const requestId = 'probe-' + kind
      let runtime
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(kind + ' probe timed out')),
          5000,
        )
        runtime = factory((event) => {
          if (event.type !== 'reply' || event.requestId !== requestId) return
          clearTimeout(timeout)
          if (event.ok) resolve()
          else reject(new Error(kind + ' probe failed'))
        })
        runtime.dispatch({ type: 'probeHooksRuntime', requestId })
      })
      await runtime.shutdown()
      console.info(kind + ':ok')
    }
  })().catch((error) => {
    console.error(error)
    process.exit(1)
  })
`

const result = spawnSync(electronPath, ['-e', script], {
  cwd: desktopRoot,
  stdio: 'inherit',
  shell: false,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
  },
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
