const { app } = require('electron')

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

const timeout = (milliseconds, message) =>
  new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), milliseconds).unref()
  })

async function waitForQuarantineCleanup(addon) {
  const deadline = performance.now() + 4_500
  while (performance.now() < deadline) {
    const completions =
      addon.getRuntimeInfo()?.nativeTestQuarantineCleanupCompletions
    if (typeof completions !== 'number') {
      throw new Error('Native quarantine completion signal is unavailable')
    }
    if (completions >= 1) return
    await delay(25)
  }
  throw new Error('Retained native quarantine cleanup did not complete')
}

async function run() {
  const nativeModulePath = process.env.SYRNIKE_NATIVE_MODULE_PATH
  if (!nativeModulePath) {
    throw new Error('SYRNIKE_NATIVE_MODULE_PATH is not set')
  }

  const addon = require(nativeModulePath)
  let probeReplied = false
  let resolveBlockEntered
  const blockEntered = new Promise((resolve) => {
    resolveBlockEntered = resolve
  })
  const runtime = addon.createMediaRuntime((event) => {
    if (event?.type === 'nativeSmokeQuarantineBlockEntered') {
      resolveBlockEntered()
    }
    if (event?.type === 'reply' &&
        event.requestId === 'native-quarantine-blocker') {
      probeReplied = true
    }
  })
  await runtime.ready()
  runtime.dispatch({
    type: 'configureMicrophone',
    requestId: 'native-quarantine-blocker',
    sessionId: 'native-quarantine',
    generation: 1,
  })

  await Promise.race([
    blockEntered,
    timeout(1_000, 'Native quarantine blocker did not enter'),
  ])
  if (probeReplied) {
    throw new Error('Native quarantine blocker completed before shutdown')
  }

  const shutdownStarted = performance.now()
  await Promise.race([
    runtime.shutdown(),
    timeout(1_500, 'Native quarantine shutdown exceeded its bounded budget'),
  ])
  if (performance.now() - shutdownStarted >= 1_500) {
    throw new Error('Native quarantine shutdown exceeded its bounded budget')
  }
  if (probeReplied) {
    throw new Error('Blocked native operation was joined during shutdown')
  }

  await waitForQuarantineCleanup(addon)
  await new Promise((resolve) => {
    process.stdout.write('native-quarantine-launch-retry-ok\n', resolve)
  })
}

app.disableHardwareAcceleration()
void app.whenReady().then(run).then(
  () => app.exit(0),
  (error) => {
    process.stderr.write(`${error?.stack ?? error}\n`)
    app.exit(1)
  },
)
