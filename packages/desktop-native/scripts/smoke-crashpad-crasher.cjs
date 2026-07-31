const { app, crashReporter } = require('electron')

const crashRoot = process.env.SYRNIKE_CRASHPAD_PROBE_ROOT
if (!crashRoot) throw new Error('Crashpad probe root is missing')

app.setPath('crashDumps', crashRoot)
crashReporter.start({
  uploadToServer: false,
  globalExtra: {
    native_crash_probe: 'electron-main',
  },
})

app.whenReady().then(() => {
  crashReporter.addExtraParameter('native_runtime_kind', 'media-probe')
  crashReporter.addExtraParameter(
    'native_host_stage',
    'intentional_probe_crash',
  )
  process.crash()
})
