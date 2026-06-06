import { app } from 'electron'

/** Регистрирует или снимает автозапуск в ОС (только в packaged-сборке). */
export function applyLoginItemSettings(openAtLogin: boolean) {
  if (!app.isPackaged) return

  const settings: Electron.Settings = {
    openAtLogin,
  }

  if (process.platform === 'darwin') {
    settings.openAsHidden = false
  }

  if (process.platform === 'win32') {
    settings.path = process.execPath
    settings.args = []
  }

  app.setLoginItemSettings(settings)
}
