import { CheckIcon } from '#/components/icons'

import { voiceStagePopoverMenuItemClass } from '#/components/voice/voice-stage-popover-styles'
import { cn } from '#/lib/utils'

export function deviceMenuLabel(device: MediaDeviceInfo) {
  return device.label.trim() || 'Устройство'
}

/** Devices the user can pick; enumeration without permission yields empty ids. */
export function selectableDevices(devices: MediaDeviceInfo[]) {
  return devices.filter((device) => device.deviceId.length > 0)
}

/** "По умолчанию" names the device the runtime will actually open. */
export function defaultDeviceMenuLabel(devices: MediaDeviceInfo[]) {
  const first = selectableDevices(devices)[0]
  return first ? `По умолчанию (${deviceMenuLabel(first)})` : 'По умолчанию'
}

export function VoiceDeviceMenuItem({
  label,
  selected,
  onSelect,
}: {
  label: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      className={cn(voiceStagePopoverMenuItemClass, selected && 'bg-accent/60')}
      onClick={onSelect}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected ? (
        <CheckIcon className="size-4 shrink-0 text-primary" />
      ) : (
        <span className="size-4 shrink-0" aria-hidden />
      )}
    </button>
  )
}
