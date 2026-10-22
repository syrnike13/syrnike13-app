import type { Translator } from '@syrnike13/ui/i18n'

/** Devices the user can pick; enumeration without permission yields empty ids. */
export function selectableDevices(devices: MediaDeviceInfo[]) {
  return devices.filter((device) => device.deviceId.length > 0)
}

/** A device's own name, or the generic one when enumeration hid it. */
export function deviceLabel(device: MediaDeviceInfo, t: Translator) {
  return device.label.trim() || t('devices.device')
}
