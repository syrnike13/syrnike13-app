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
    if (/^(sdk-screen-|screen-audio-|encoder-|wgc-monitor-|wgc-window-|dxgi-)/.test(point)) {
      await ui.getByRole('button', { name: 'Демонстрация экрана', exact: true }).first().click()
      if (point.startsWith('wgc-window-')) {
        const picker = ui.getByRole('dialog', { name: 'Демонстрация экрана', exact: true })
        const applications = picker.getByRole('tab', { name: /^Приложения(?:\s+\d+)?$/ })
        const source = picker.getByRole('button', { name: screenSourceButton, exact: true })
        // Window sources are paginated independently of their titles or z-order.
        // Keep fixture discovery bounded and use visible page state to advance.
        for (let page = 0; page < 64; ++page) {
          await applications.click()
          const panel = picker.locator('[role="tabpanel"][data-state="active"]')
          await until(async () => (await panel.getByRole('button').count()) > 0 ||
            await panel.getByText('Приложения не найдены', { exact: true }).isVisible(),
          Boolean, 'shutdown_picker_sources_deadline')
          if (await source.isVisible()) break
          const next = picker.getByRole('button', { name: 'Далее', exact: true })
          if (!(await next.isVisible()) || !(await next.isEnabled())) throw new Error('shutdown_window_source_missing')
          const indicator = next.locator('..').locator(':scope > span')
          const previousPage = await indicator.innerText()
          await next.click()
          await until(() => indicator.innerText(), value => value !== previousPage,
            'shutdown_picker_page_deadline')
        }
        if (!(await source.isVisible())) throw new Error('shutdown_window_source_page_limit')
      }
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
