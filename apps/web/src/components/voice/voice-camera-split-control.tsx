import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'

import { Settings2Icon, VideoIcon, VideoOffIcon } from '#/components/icons'
import { Popover, PopoverContent } from '@syrnike13/ui/primitives/popover'
import { RadioGroup } from '@syrnike13/ui/primitives/radio-group'
import {
  VoicePopoverHint,
  VoicePopoverRadioRow,
  VoicePopoverRow,
  VoicePopoverTitle,
} from '#/components/voice/voice-popover-rows'
import { Separator } from '@syrnike13/ui/primitives/separator'
import { deviceLabel, selectableDevices } from '#/components/voice/voice-device-list'
import {
  VoiceSplitControl,
  type VoiceSplitControlSurface,
} from '#/components/voice/voice-split-control'
import { useSettingsModal } from '#/features/settings/settings-modal-context'
import { useMediaDevices } from '#/features/voice/use-media-devices'
import { useVoiceMedia } from '#/features/voice/voice-media-context'
import { useVoicePreferences } from '#/features/voice/use-voice-preferences'

const DEFAULT_DEVICE_VALUE = '__default__'

/** Camera control with a device list behind the chevron. */
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
  const t = useTranslations('voice')
  const { cameraDeviceFailed } = useVoiceMedia()
  const [open, setOpen] = useCameraDevicePickerOpen(STAGE_PICKER_PRIORITY)

  return (
    <VoiceSplitControl
      surface={surface}
      success={cameraOn}
      danger={cameraDeviceFailed}
      disabled={disabled}
      mainTitle={title}
      chevronTitle={t('actions.cameraSettings')}
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

/** Camera picker anchored to a camera button that has no chevron of its own. */
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
  const anchorRef = useRef<HTMLDivElement>(null)

  return (
    <>
      <div ref={anchorRef} className={className}>
        {children}
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverContent
          anchor={anchorRef}
          align="start"
          side={side}
          sideOffset={8}
          initialFocus={false}
          data-voice-stage-popover
          className="z-420 w-72"
        >
          <VoiceCameraSettingsMenuContent onSelected={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
    </>
  )
}

export function VoiceCameraSettingsMenuContent({
  onSelected,
}: {
  onSelected?: () => void
}) {
  const t = useTranslations('voice')
  const { cameraDeviceFailed, selectCameraDevice } = useVoiceMedia()
  const prefs = useVoicePreferences()
  const { openSettings } = useSettingsModal()
  const devices = selectableDevices(useMediaDevices('videoinput'))
  const selectedId = prefs.preferredVideoDevice

  const select = (value: string) => {
    selectCameraDevice(value === DEFAULT_DEVICE_VALUE ? undefined : value)
    onSelected?.()
  }

  return (
    <div className="flex flex-col gap-1">
      <VoicePopoverTitle>{t('devices.camera')}</VoicePopoverTitle>
      {cameraDeviceFailed ? (
        <VoicePopoverHint tone="destructive">
          {t('devices.cameraOpenFailed')}
        </VoicePopoverHint>
      ) : null}
      {devices.length === 0 ? (
        <VoicePopoverHint>{t('devices.noCameras')}</VoicePopoverHint>
      ) : (
        <RadioGroup
          value={selectedId ?? DEFAULT_DEVICE_VALUE}
          aria-label={t('devices.camera')}
          className="gap-0"
          onValueChange={select}
        >
          <VoicePopoverRadioRow
            value={DEFAULT_DEVICE_VALUE}
            label={t('devices.default')}
          />
          {devices.map((device) => (
            <VoicePopoverRadioRow
              key={device.deviceId}
              value={device.deviceId}
              label={deviceLabel(device, t)}
            />
          ))}
        </RadioGroup>
      )}
      <Separator className="my-1" />
      <VoicePopoverRow
        label={t('devices.voiceSettings')}
        trailing={<Settings2Icon />}
        onClick={() => openSettings('voice')}
      />
    </div>
  )
}
