import type { Translator } from '@syrnike13/ui/i18n'

/** Chromium aliases for the system default devices; we offer our own default. */
const BROWSER_ALIAS_DEVICE_IDS = new Set(['default', 'communications'])

/** Devices the user can pick; enumeration without permission yields empty ids. */
export function selectableDevices(devices: MediaDeviceInfo[]) {
  return devices.filter(
    (device) =>
      device.deviceId.length > 0 && !BROWSER_ALIAS_DEVICE_IDS.has(device.deviceId),
  )
}

/** The device the system uses by default: Chromium's alias target, else the first. */
export function systemDefaultDevice(devices: MediaDeviceInfo[]) {
  const selectable = selectableDevices(devices)
  const alias = devices.find((device) => device.deviceId === 'default')
  const target = alias?.groupId
    ? selectable.find((device) => device.groupId === alias.groupId)
    : undefined
  return target ?? selectable[0]
}

/** A device's own name, or the generic one when enumeration hid it. */
export function deviceLabel(device: MediaDeviceInfo, t: Translator) {
  return device.label.trim() || t('devices.device')
}
