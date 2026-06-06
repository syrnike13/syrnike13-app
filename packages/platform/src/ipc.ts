/** Каналы IPC между renderer (web) и main process. */
export const IPC = {
  versions: 'syrnike-desktop:versions',
  windowMinimize: 'syrnike-desktop:window:minimize',
  windowMaximize: 'syrnike-desktop:window:maximize',
  windowClose: 'syrnike-desktop:window:close',
  windowIsMaximized: 'syrnike-desktop:window:is-maximized',
  windowShow: 'syrnike-desktop:window:show',
  windowGetPreferences: 'syrnike-desktop:window:get-preferences',
  windowSetCloseToTray: 'syrnike-desktop:window:set-close-to-tray',
  updatesGetState: 'syrnike-desktop:updates:get-state',
  updatesCheck: 'syrnike-desktop:updates:check',
  updatesInstall: 'syrnike-desktop:updates:install',
  updatesStateChanged: 'syrnike-desktop:updates:state-changed',
  activitySet: 'syrnike-desktop:activity:set',
  activityClear: 'syrnike-desktop:activity:clear',
  hotkeysGetBindings: 'syrnike-desktop:hotkeys:get-bindings',
  hotkeysSetBindings: 'syrnike-desktop:hotkeys:set-bindings',
  hotkeysSetSuspended: 'syrnike-desktop:hotkeys:set-suspended',
  hotkeysStartRecording: 'syrnike-desktop:hotkeys:start-recording',
  hotkeysStopRecording: 'syrnike-desktop:hotkeys:stop-recording',
  hotkeysGetRuntimeStatus: 'syrnike-desktop:hotkeys:get-runtime-status',
  hotkeysRecordedInput: 'syrnike-desktop:hotkeys:recorded-input',
  hotkeysPressed: 'syrnike-desktop:hotkeys:pressed',
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
