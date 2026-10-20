import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Settings2Icon, VideoIcon, VideoOffIcon } from '#/components/icons'

import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '#/components/ui/popover'
import {
  defaultDeviceMenuLabel,
  deviceMenuLabel,
  selectableDevices,
  VoiceDeviceMenuItem,
} from '#/components/voice/voice-device-menu'
import {
  VoiceSplitControl,
  type VoiceSplitControlSurface,
} from '#/components/voice/voice-split-control'
import {
  voiceStagePopoverHintClass,
  voiceStagePopoverMenuItemClass,
  voiceStagePopoverMicSettingsClass,
  voiceStagePopoverSectionTitleClass,
  voiceStagePopoverSeparatorClass,
} from '#/components/voice/voice-stage-popover-styles'
import { useSettingsModal } from '#/features/settings/settings-modal-context'
import { useMediaDevices } from '#/features/voice/use-media-devices'
import { useVoiceMedia } from '#/features/voice/voice-media-context'
import { useVoicePreferences } from '#/features/voice/use-voice-preferences'
import { cn } from '#/lib/utils'

export function VoiceCameraSplitControl({
  surface,
  title,
  disabled,
  cameraOn,
  onToggleCamera,
}: {
  surface: VoiceSplitControlSurface
  title: string
  disabled: boolean
  cameraOn: boolean
  onToggleCamera: () => void
}) {
  const { cameraDeviceFailed } = useVoiceMedia()
  const [open, setOpen] = useCameraDevicePickerOpen(STAGE_PICKER_PRIORITY)

  return (
    <VoiceSplitControl
      surface={surface}
      success={cameraOn}
      danger={cameraDeviceFailed}
      disabled={disabled}
      mainTitle={title}
      chevronTitle="Параметры камеры"
      onMainClick={onToggleCamera}
      popoverOpen={open}
      onPopoverOpenChange={setOpen}
      popoverContent={
        <VoiceCameraSettingsMenuContent onSelected={() => setOpen(false)} />
      }
    >
      {cameraOn ? (
        <VideoIcon className="size-5" />
      ) : (
        <VideoOffIcon className="size-5" />
      )}
    </VoiceSplitControl>
  )
}

const STAGE_PICKER_PRIORITY = 2
const ANCHOR_PICKER_PRIORITY = 1

type PickerClaim = { readonly priority: number }

/** Mounted camera pickers; exactly one answers each picker request. */
const pickerClaims = new Set<PickerClaim>()

function ownsPickerRequest(claim: PickerClaim) {
  let owner: PickerClaim | null = null
  for (const candidate of pickerClaims) {
    if (!owner || candidate.priority > owner.priority) owner = candidate
  }
  return owner === claim
}

/**
 * Opens when the voice runtime asks the user to pick a camera. The stage
 * control wins over the panel/legacy/mobile anchors, so one failure opens
 * one list even when several camera buttons are mounted.
 */
function useCameraDevicePickerOpen(priority: number) {
  const { cameraDevicePickerRequest } = useVoiceMedia()
  const [open, setOpen] = useState(false)
  const [claim] = useState<PickerClaim>(() => ({ priority }))
  const handledRequestRef = useRef(cameraDevicePickerRequest)

  useEffect(() => {
    pickerClaims.add(claim)
    return () => {
      pickerClaims.delete(claim)
    }
  }, [claim])

  useEffect(() => {
    if (cameraDevicePickerRequest === handledRequestRef.current) return
    handledRequestRef.current = cameraDevicePickerRequest
    if (ownsPickerRequest(claim)) setOpen(true)
  }, [cameraDevicePickerRequest, claim])

  return [open, setOpen] as const
}

/** Camera picker anchored to a plain camera button without a chevron. */
export function CameraDevicePickerAnchor({
  side = 'top',
  className,
  children,
}: {
  side?: 'top' | 'bottom'
  /** Layout of the anchor box around the camera button. */
  className?: string
  children: ReactNode
}) {
  const [open, setOpen] = useCameraDevicePickerOpen(ANCHOR_PICKER_PRIORITY)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className={className}>{children}</div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        side={side}
        sideOffset={8}
        data-voice-stage-popover
        className={cn(voiceStagePopoverMicSettingsClass, 'z-[200]')}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <VoiceCameraSettingsMenuContent onSelected={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

export function VoiceCameraSettingsMenuContent({
  onSelected,
}: {
  onSelected?: () => void
}) {
  const { cameraDeviceFailed, selectCameraDevice } = useVoiceMedia()
  const prefs = useVoicePreferences()
  const { openSettings } = useSettingsModal()
  const devices = selectableDevices(useMediaDevices('videoinput'))
  const selectedId = prefs.preferredVideoDevice
  const select = (deviceId: string | undefined) => {
    selectCameraDevice(deviceId)
    onSelected?.()
  }

  return (
    <div className="flex flex-col gap-1">
      <p className={cn(voiceStagePopoverSectionTitleClass, 'px-2 pt-1')}>
        Камера
      </p>
      {cameraDeviceFailed ? (
        <p className={cn(voiceStagePopoverHintClass, 'px-2 text-destructive')}>
          Не удалось включить камеру. Выберите устройство.
        </p>
      ) : null}
      <VoiceDeviceMenuItem
        label={defaultDeviceMenuLabel(devices)}
        selected={!selectedId}
        onSelect={() => select(undefined)}
      />
      {devices.map((device) => (
        <VoiceDeviceMenuItem
          key={device.deviceId}
          label={deviceMenuLabel(device)}
          selected={selectedId === device.deviceId}
          onSelect={() => select(device.deviceId)}
        />
      ))}
      {devices.length === 0 ? (
        <p className={cn(voiceStagePopoverHintClass, 'px-2')}>
          Камеры не найдены
        </p>
      ) : null}
      <div className={voiceStagePopoverSeparatorClass} role="separator" />
      <button
        type="button"
        className={cn(voiceStagePopoverMenuItemClass, 'justify-between')}
        onClick={() => openSettings('voice')}
      >
        <span>Настройки голоса</span>
        <Settings2Icon className="size-4 shrink-0 text-muted-foreground" />
      </button>
    </div>
  )
}
