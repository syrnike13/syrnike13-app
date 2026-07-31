const { app } = require('electron')

const CONTROL_EVENT_COUNT = 128
const JS_FREEZE_MS = 5_000

async function run() {
  const addon = require(process.env.SYRNIKE_NATIVE_MODULE_PATH)
  let delivered = 0
  let nextExpected = 0
  let threw = false
  let runtime
  const allDelivered = new Promise((resolve) => {
    runtime = addon.createMediaRuntime((event) => {
      if (event?.type !== 'reply' ||
          !event.requestId?.startsWith('node-event-smoke-')) return
      const index = Number(event.requestId.slice('node-event-smoke-'.length))
      if (index !== nextExpected) {
        throw new Error(
          `Control delivery reordered ${index}; expected ${nextExpected}`,
        )
      }
      nextExpected += 1
      delivered += 1
      if (!threw) {
        threw = true
        throw new Error('injected JS listener failure')
      }
      if (delivered === CONTROL_EVENT_COUNT) resolve()
    })
  })
  await runtime.ready()
  for (let index = 0; index < CONTROL_EVENT_COUNT; index += 1) {
    runtime.dispatch({
      type: 'probeQueryWorker',
      requestId: `node-event-smoke-${index}`,
    })
  }

  const frozenUntil = performance.now() + JS_FREEZE_MS
  while (performance.now() < frozenUntil) {
    // Deliberately keep Electron's JS thread unavailable while native workers
    // fill the lossless control lane.
  }

  await Promise.race([
    allDelivered,
    new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error(
          `Control delivery stopped after ${delivered}/${CONTROL_EVENT_COUNT} events`,
        )),
        2_000,
      )
    }),
  ])
  await runtime.shutdown()
  process.stdout.write('node-event-listener-and-backpressure-ok\n')
}

app.disableHardwareAcceleration()
void app.whenReady().then(run).then(
  () => app.exit(0),
  (error) => {
    process.stderr.write(`${error?.stack ?? error}\n`)
    app.exit(1)
  },
)
