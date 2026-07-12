import { useEffect, useState } from 'react'

import { getSyrnikeDesktop } from '#/platform/runtime'

function usesNativeMediaDevices(kind: MediaDeviceKind) {
  return (
    getSyrnikeDesktop()?.platform.os === 'win32' &&
    (kind === 'audioinput' || kind === 'audiooutput' || kind === 'videoinput')
  )
}

export async function listMediaDevices(kind: MediaDeviceKind) {
  const desktop = getSyrnikeDesktop()
  if (usesNativeMediaDevices(kind) && desktop?.platform.os === 'win32') {
    return desktop.media.listDevices(kind) as Promise<MediaDeviceInfo[]>
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
    if (usesNativeMediaDevices(kind)) {
      const interval = window.setInterval(refresh, 2_000)
      return () => {
        active = false
        window.clearInterval(interval)
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
  if (kind === 'audio' && usesNativeMediaDevices('audioinput')) {
    return
  }

  const constraints =
    kind === 'audio' ? { audio: true } : { video: true, audio: false }
  const stream = await navigator.mediaDevices.getUserMedia(constraints)
  for (const track of stream.getTracks()) {
    track.stop()
  }
}
