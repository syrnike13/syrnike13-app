const { app } = require('electron')

async function run() {
  const addon = require(process.env.SYRNIKE_NATIVE_MODULE_PATH)
  let runtime
  const removed = new Promise((resolve) => {
    runtime = addon.createMediaRuntime((event) => {
      if (event?.type === 'localScreenPreviewTrackRemoved') resolve(event)
    })
  })
  await runtime.ready()
  runtime.dispatch({
    type: '__localScreenPreviewTrackRemoved',
    requestId: 'media-event-serialization-smoke',
    sessionId: 'screen-event-serialization-smoke',
    generation: 1,
    trackId: 'local-screen:screen-event-serialization-smoke',
  })
  const timeout = new Promise((_, reject) => {
    setTimeout(
      () => reject(new Error('Timed out waiting for local preview removal event')),
      10_000,
    ).unref()
  })
  const event = await Promise.race([removed, timeout])
  if (event.source !== 'screen') {
    throw new Error('Local preview removal event omitted its screen source')
  }
  process.stdout.write('local-preview-removal-source-ok\n')
  await new Promise(() => {})
}

app.disableHardwareAcceleration()
void app.whenReady().then(run).then(
  () => process.exit(0),
  () => process.exit(1),
)
