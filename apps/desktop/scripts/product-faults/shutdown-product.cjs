const { resolve } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

async function until(read, accepts, code) {
  let stopped = false
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(code)), 15000)
  })
  try {
    await Promise.race([deadline, (async () => {
      while (!stopped) {
        const value = await read()
        if (stopped || accepts(value)) return
        await delay(25)
      }
    })()])
  } finally {
    stopped = true
    clearTimeout(timer)
  }
}

// Launch the isolated compiled product using its existing diagnostic profile.
// Only production preload commands are used to reach the held native boundary.
exports.createProduct = ({ electron, executablePath, applicationDirectory, environment,
  serverName, channelId, screenSourceButton }) => {
  const directory = resolve(applicationDirectory)
  let ui

  async function launch() {
    const app = await electron.launch({ executablePath, args: [directory], cwd: directory,
      env: environment, timeout: 60000 })
    try {
      ui = await app.firstWindow()
      await ui.waitForFunction(() => Boolean(window.syrnikeDesktop?.media))
      await until(() => ui.evaluate(() => window.syrnikeDesktop.media.getRuntimeState()),
        state => state.status === 'ready', 'shutdown_runtime_ready_deadline')
      // Ready is lazy: device enumeration starts and handshakes the utility
      // before inventory, without starting a Room or a capture operation.
      await ui.evaluate(() => window.syrnikeDesktop.media.listDevices('audioinput'))
      await ui.getByRole('link', { name: serverName, exact: true }).waitFor({ state: 'attached' })
      return app
    } catch (error) {
      await app.close()
      throw error
    }
  }

  async function inventory(app) {
    return app.evaluate(({ app }) => ({
      mainPid: process.pid,
      mediaPids: app.getAppMetrics().filter(metric =>
        metric.type === 'Utility' && metric.name === 'syrnike-windows-media-lifecycle',
      ).map(metric => metric.pid),
    }))
  }

  const dispatch = command => ui.evaluate(value => {
    void window.syrnikeDesktop.voice.dispatch(value)
  }, command)
  const snapshot = () => ui.evaluate(() => window.syrnikeDesktop.voice.getSnapshot())
  const connected = () => until(snapshot, state => state.connection === 'connected', 'shutdown_room_ready_deadline')
  const running = track => until(snapshot, state => state[track].state === 'running', 'shutdown_track_ready_deadline')

  async function enterFault(_app, point, waitForPoint) {
    await dispatch({ type: 'join', channelId })
    if (point === 'sdk-connect') return
    if (point === 'sdk-cancel') {
      await waitForPoint('sdk-connect')
      await dispatch({ type: 'leave' })
      return
    }
    await connected()
    if (point === 'sdk-disconnect' || point === 'sdk-microphone-unpublish') {
      await running('microphone')
      await dispatch({ type: 'leave' })
      return
    }
    if (point.startsWith('microphone-') || point === 'sdk-microphone-publish' || point.startsWith('output-')) return
    if (point.startsWith('sdk-camera-') || point === 'camera-read-sample') {
      await dispatch({ type: 'setCamera', enabled: true })
      if (point === 'sdk-camera-unpublish') {
        await running('camera')
        await dispatch({ type: 'setCamera', enabled: false })
      }
      return
    }
    if (/^(sdk-screen-|screen-audio-|encoder-|wgc-monitor-)/.test(point)) {
      await ui.getByRole('button', { name: 'Демонстрация экрана', exact: true }).first().click()
      await ui.getByRole('button', { name: screenSourceButton, exact: true }).click()
      if (point.endsWith('-unpublish')) {
        await running(point === 'sdk-screen-unpublish' ? 'screen' : 'screenAudio')
        await dispatch({ type: 'setScreen', enabled: false })
      }
      return
    }
    throw new Error('shutdown_scenario_point_unsupported')
  }

  return { launch, inventory, enterFault }
}
