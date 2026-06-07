import { useEffect, useState } from 'react'

import { getSyrnikeDesktop } from '#/platform/runtime'

function usesNativeAudioInput() {
  return getSyrnikeDesktop()?.platform.os === 'win32'
}

export async function listMediaDevices(kind: MediaDeviceKind) {
  const desktop = getSyrnikeDesktop()
  if (kind === 'audioinput' && desktop?.platform.os === 'win32') {
    return desktop.media.listDevices('audioinput') as Promise<MediaDeviceInfo[]>
  }

  const listed = await navigator.mediaDevices.enumerateDevices()
  return listed.filter((device) => device.kind === kind)
}

export function useMediaDevices(kind: MediaDeviceKind) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])

  useEffect(() => {
    let active = true

    async function refresh() {
      try {
        const listed = await listMediaDevices(kind)
        if (!active) return
        setDevices(listed)
      } catch {
        if (active) setDevices([])
      }
    }

    void refresh()
    if (kind === 'audioinput' && usesNativeAudioInput()) {
      return () => {
        active = false
      }
    }

    navigator.mediaDevices.addEventListener('devicechange', refresh)
    return () => {
      active = false
      navigator.mediaDevices.removeEventListener('devicechange', refresh)
    }
  }, [kind])

  return devices
}

export async function ensureMediaDevicePermission(kind: 'audio' | 'video') {
  if (!navigator.mediaDevices?.getUserMedia) return
  if (kind === 'audio' && usesNativeAudioInput()) {
    return
  }

  const constraints =
    kind === 'audio' ? { audio: true } : { video: true, audio: false }
  const stream = await navigator.mediaDevices.getUserMedia(constraints)
  for (const track of stream.getTracks()) {
    track.stop()
  }
}
