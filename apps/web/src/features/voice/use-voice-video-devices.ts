import { useEffect, useState } from 'react'

import { shouldUseDesktopMediaEngine } from '#/features/voice/desktop-media-engine'
import { useMediaDevices } from '#/features/voice/use-media-devices'
import {
  engineDevicesToMediaDeviceInfo,
  reconcilePreferredDeviceId,
} from '#/features/voice/voice-audio-devices'
import { voicePreferenceStore } from '#/features/voice/voice-preference-store'
import { getSyrnikeDesktop } from '#/platform/runtime'

const ENGINE_DEVICES_REFRESH_MS = 5_000

export function useVoiceVideoDevices() {
  const useEngine = shouldUseDesktopMediaEngine()
  const browserDevices = useMediaDevices('videoinput')
  const [engineDevices, setEngineDevices] = useState<MediaDeviceInfo[]>([])

  useEffect(() => {
    if (!useEngine) return

    let active = true

    async function refresh() {
      const desktop = getSyrnikeDesktop()
      if (!desktop) {
        if (active) setEngineDevices([])
        return
      }

      try {
        const result = await desktop.mediaEngine.devicesList()
        if (!active) return
        const inputs = result.devices.filter(
          (device) => device.kind === 'videoinput',
        )
        setEngineDevices(engineDevicesToMediaDeviceInfo(inputs))
      } catch {
        if (active) setEngineDevices([])
      }
    }

    void refresh()
    const interval = window.setInterval(() => void refresh(), ENGINE_DEVICES_REFRESH_MS)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [useEngine])

  useEffect(() => {
    if (!useEngine || engineDevices.length === 0) return

    const stored = voicePreferenceStore.getPreferredVideoDevice()
    if (!stored) return
    if (engineDevices.some((device) => device.deviceId === stored)) return

    const browserMatch = browserDevices.find((device) => device.deviceId === stored)
    const available = engineDevices.map((device) => ({
      id: device.deviceId,
      label: device.label,
    }))
    const reconciled = reconcilePreferredDeviceId(
      stored,
      available,
      browserMatch?.label,
    )

    if (reconciled) {
      voicePreferenceStore.setPreferredVideoDevice(reconciled)
      return
    }

    voicePreferenceStore.setPreferredVideoDevice(undefined)
  }, [browserDevices, engineDevices, useEngine])

  return useEngine ? engineDevices : browserDevices
}
