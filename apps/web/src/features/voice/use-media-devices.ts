import { useEffect, useState } from 'react'

export function useMediaDevices(kind: MediaDeviceKind) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])

  useEffect(() => {
    let active = true

    async function refresh() {
      try {
        const listed = await navigator.mediaDevices.enumerateDevices()
        if (!active) return
        setDevices(listed.filter((device) => device.kind === kind))
      } catch {
        if (active) setDevices([])
      }
    }

    void refresh()
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
  const constraints =
    kind === 'audio' ? { audio: true } : { video: true, audio: false }
  const stream = await navigator.mediaDevices.getUserMedia(constraints)
  for (const track of stream.getTracks()) {
    track.stop()
  }
}
