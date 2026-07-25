const { app } = require('electron')

async function run() {
  const addon = require(process.env.SYRNIKE_NATIVE_MODULE_PATH)
  const factory = addon[process.env.SYRNIKE_NATIVE_RUNTIME_FACTORY]
  if (typeof factory !== 'function') {
    throw new Error('Native runtime factory is unavailable')
  }
  const runtime = factory(() => {})
  if (typeof runtime.ready === 'function') {
    await runtime.ready()
  }
  process.stdout.write('async-cleanup-launch-failure-armed\n')
}

app.disableHardwareAcceleration()
void app.whenReady().then(run).then(
  () => app.exit(0),
  (error) => {
    process.stderr.write(`${error?.stack ?? error}\n`)
    app.exit(1)
  },
)
