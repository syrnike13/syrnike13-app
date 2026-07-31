const { app } = require('electron')

const timeout = (milliseconds, message) =>
  new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), milliseconds).unref()
  })

async function createDroppedRuntime(addon, finalized) {
  let runtime = addon.createMediaRuntime(() => {})
  await runtime.ready()
  finalized.register(runtime, undefined)
  runtime = null
}

async function run() {
  if (typeof global.gc !== 'function') {
    throw new Error('Electron did not expose garbage collection')
  }
  const addon = require(process.env.SYRNIKE_NATIVE_MODULE_PATH)
  let resolveFinalized
  const finalizedPromise = new Promise((resolve) => {
    resolveFinalized = resolve
  })
  const finalized = new FinalizationRegistry(resolveFinalized)

  await createDroppedRuntime(addon, finalized)
  global.gc()
  await Promise.race([
    finalizedPromise,
    timeout(5_000, 'Dropped media runtime was not finalized'),
  ])

  // The finalizer synchronously shuts down and clears the per-env singleton.
  // This is deliberately one create call: retries would hide a stale registry.
  const replacement = addon.createMediaRuntime(() => {})
  await replacement.ready()
  await replacement.shutdown()
  process.stdout.write('dropped-objectwrap-immediate-recreate-ok\n')
}

app.disableHardwareAcceleration()
void app.whenReady().then(run).then(
  () => app.exit(0),
  (error) => {
    process.stderr.write(`${error?.stack ?? error}\n`)
    app.exit(1)
  },
)
