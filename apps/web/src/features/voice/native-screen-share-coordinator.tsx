import { useEffect } from 'react'

import {
  clearNativePickerSelection,
  rejectNativePickerSelection,
  resolveNativePickerSelection,
} from '#/features/voice/native-screen-share-session'
import { usePlatform } from '#/platform/use-platform'

export function NativeScreenShareCoordinator() {
  const { desktop } = usePlatform()

  useEffect(() => {
    if (!desktop) return

    return desktop.media.onDisplayPickerResolved((payload) => {
      resolveNativePickerSelection(payload.sourceId)
    })
  }, [desktop])

  useEffect(() => {
    return () => {
      clearNativePickerSelection()
    }
  }, [])

  useEffect(() => {
    if (!desktop) return

    const handleBeforeUnload = () => {
      rejectNativePickerSelection(new Error('Screen share picker closed'))
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [desktop])

  return null
}
