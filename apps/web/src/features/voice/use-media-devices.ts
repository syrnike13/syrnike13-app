import { useEffect, useState } from 'react'
import { Effect, Fiber } from 'effect'

import { getSyrnikeDesktop } from '#/platform/runtime'

class DesktopMediaDeviceInfo implements MediaDeviceInfo {
  constructor(
    readonly deviceId: string,
    readonly kind: MediaDeviceKind,
    readonly label: string,
  ) {}

  get groupId() {
    return ''
  }

  toJSON() {
    return {
      deviceId: this.deviceId,
      groupId: this.groupId,
      kind: this.kind,
      label: this.label,
    }
  }
}

function usesNativeMediaDevices(kind: MediaDeviceKind) {
  return (
    getSyrnikeDesktop()?.platform.os === 'win32' &&
    (kind === 'audioinput' || kind === 'audiooutput' || kind === 'videoinput')
  )
}

export const listMediaDevicesEffect = Effect.fn('voice.listMediaDevices')(
  function*(kind: MediaDeviceKind) {
    const desktop = getSyrnikeDesktop()
    if (usesNativeMediaDevices(kind) && desktop?.platform.os === 'win32') {
      const devices = yield* Effect.tryPromise({
        try: () => desktop.media.listDevices(kind),
        catch: (cause) => cause,
      })
      return devices.map(
        (device) =>
          new DesktopMediaDeviceInfo(
            device.deviceId,
            device.kind,
            device.label,
          ),
      )
    }

    const listed = yield* Effect.tryPromise({
      try: () => navigator.mediaDevices.enumerateDevices(),
      catch: (cause) => cause,
    })
    return listed.filter((device) => device.kind === kind)
  },
)

export function useMediaDevices(kind: MediaDeviceKind) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])

  useEffect(() => {
    let refreshFiber: ReturnType<typeof Effect.runFork> | undefined

    function refresh() {
      if (refreshFiber) Effect.runFork(Fiber.interrupt(refreshFiber))
      refreshFiber = Effect.runFork(
        listMediaDevicesEffect(kind).pipe(
          Effect.matchEffect({
            onFailure: () =>
              Effect.sync(() => {
                setDevices([])
              }),
            onSuccess: (listed) =>
              Effect.sync(() => {
                setDevices(listed)
              }),
          }),
        ),
      )
    }

    refresh()
    navigator.mediaDevices.addEventListener('devicechange', refresh)
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', refresh)
      if (refreshFiber) Effect.runFork(Fiber.interrupt(refreshFiber))
    }
  }, [kind])

  return devices
}

export const ensureMediaDevicePermissionEffect = Effect.fn(
  'voice.ensureMediaDevicePermission',
)(function*(kind: 'audio' | 'video') {
  if (!navigator.mediaDevices?.getUserMedia) return
  if (kind === 'audio' && usesNativeMediaDevices('audioinput')) {
    return
  }

  const constraints =
    kind === 'audio' ? { audio: true } : { video: true, audio: false }
  const acquireStream = Effect.callback<MediaStream, unknown>((resume) => {
    let interrupted = false
    void navigator.mediaDevices.getUserMedia(constraints).then(
      (stream) => {
        if (!interrupted) {
          resume(Effect.succeed(stream))
          return
        }
        for (const track of stream.getTracks()) {
          track.stop()
        }
      },
      (cause) => {
        if (!interrupted) resume(Effect.fail(cause))
      },
    )
    return Effect.sync(() => {
      interrupted = true
    })
  })
  yield* Effect.acquireUseRelease(
    acquireStream,
    () => Effect.void,
    (stream) =>
      Effect.sync(() => {
        for (const track of stream.getTracks()) {
          track.stop()
        }
      }),
  )
})
