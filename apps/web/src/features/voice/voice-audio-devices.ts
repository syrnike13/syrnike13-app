import type { MediaEngineAudioDevice } from '@syrnike13/platform'

export type VoiceListedAudioDevice = {
  id: string
  label: string
}

export function normalizeDeviceLabel(label: string) {
  return label.trim().toLowerCase()
}

export function engineDevicesToMediaDeviceInfo(
  devices: MediaEngineAudioDevice[],
): MediaDeviceInfo[] {
  return devices.map((device) => ({
    deviceId: device.id,
    groupId: device.kind,
    kind: device.kind as MediaDeviceKind,
    label: device.label,
    toJSON: () => ({}),
  }))
}

export function reconcilePreferredDeviceId(
  storedId: string | undefined,
  availableDevices: VoiceListedAudioDevice[],
  fallbackLabel?: string,
): string | undefined {
  if (!storedId) return undefined
  if (availableDevices.some((device) => device.id === storedId)) {
    return storedId
  }

  const labelToMatch = fallbackLabel?.trim()
  if (!labelToMatch) return undefined

  const normalized = normalizeDeviceLabel(labelToMatch)
  const match = availableDevices.find(
    (device) => normalizeDeviceLabel(device.label) === normalized,
  )
  return match?.id
}
