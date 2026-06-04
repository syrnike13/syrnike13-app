/** Каналы IPC между renderer (web) и main process. */
export const IPC = {
  versions: 'syrnike-desktop:versions',
  windowMinimize: 'syrnike-desktop:window:minimize',
  windowMaximize: 'syrnike-desktop:window:maximize',
  windowClose: 'syrnike-desktop:window:close',
  windowIsMaximized: 'syrnike-desktop:window:is-maximized',
  activitySet: 'syrnike-desktop:activity:set',
  activityClear: 'syrnike-desktop:activity:clear',
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
