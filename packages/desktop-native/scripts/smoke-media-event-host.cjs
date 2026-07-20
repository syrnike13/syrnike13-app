const { app } = require('electron')

async function run() {
  const addon = require(process.env.SYRNIKE_NATIVE_MODULE_PATH)
  let runtime
  const removed = new Promise((resolve) => {
    const events = new Map()
    runtime = addon.createMediaRuntime((event) => {
      if (event?.type === 'localScreenPreviewTrackRemoved' ||
          event?.type === 'localCameraPreviewTrackRemoved') {
        events.set(event.type, event)
      }
      if (events.size === 2) resolve(events)
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
  runtime.dispatch({
    type: '__localCameraPreviewTrackRemoved',
    requestId: 'camera-event-serialization-smoke',
    sessionId: 'camera-event-serialization-smoke',
    generation: 2,
    trackId: 'camera-publication',
  })
  const timeout = new Promise((_, reject) => {
    setTimeout(
      () => reject(new Error('Timed out waiting for local preview removal event')),
      10_000,
    ).unref()
  })
  const events = await Promise.race([removed, timeout])
  if (events.get('localScreenPreviewTrackRemoved')?.source !== 'screen') {
    throw new Error('Local preview removal event omitted its screen source')
  }
  if (events.get('localCameraPreviewTrackRemoved')?.source !== 'camera') {
    throw new Error('Local camera preview removal event omitted its camera source')
  }
  process.stdout.write('local-preview-removal-source-ok\n')
  await new Promise(() => {})
}

app.disableHardwareAcceleration()
void app.whenReady().then(run).then(
  () => process.exit(0),
  () => process.exit(1),
)
