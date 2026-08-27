const { app } = require('electron')

const CONTROL_EVENT_COUNT = 128
const JS_FREEZE_MS = 5_000

async function run() {
  const addon = require(process.env.SYRNIKE_NATIVE_MODULE_PATH)
  let delivered = 0
  let nextExpected = 0
  let runtime
  const allDelivered = new Promise((resolve) => {
    runtime = addon.createMediaRuntime((event) => {
      if (event?.type !== 'reply') return
      if (event.requestId === 'node-event-listener-failure-smoke') {
        throw new Error('injected JS listener failure')
      }
      if (!event.requestId?.startsWith('node-event-backpressure-smoke-')) return
      const index = Number(
        event.requestId.slice('node-event-backpressure-smoke-'.length),
      )
      if (index !== nextExpected) {
        throw new Error(
          `Control delivery reordered ${index}; expected ${nextExpected}`,
        )
      }
      nextExpected += 1
      delivered += 1
      if (delivered === CONTROL_EVENT_COUNT) resolve()
    })
  })
  await runtime.ready()
  for (let index = 0; index < CONTROL_EVENT_COUNT; index += 1) {
    runtime.dispatch({
      type: 'probeQueryWorker',
      requestId: `node-event-backpressure-smoke-${index}`,
      lane: 'query',
      hostEpoch: 1,
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

  const listenerFailure = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for lossless listener escalation'))
    }, 2_000)
    process.once('uncaughtException', (error) => {
      clearTimeout(timeout)
      if (error?.code !== 'native_control_delivery_lost' ||
          error?.stage !== 'nativeEventDelivery') {
        reject(error)
        return
      }
      resolve()
    })
  })
  runtime.dispatch({
    type: 'probeQueryWorker',
    requestId: 'node-event-listener-failure-smoke',
    lane: 'query',
    hostEpoch: 1,
  })
  await listenerFailure
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
