import { useEffect } from 'react'

import { setupNativeOverlayScrollbars } from '#/lib/native-scrollbar'

export function NativeScrollbarEnhancer() {
  useEffect(() => setupNativeOverlayScrollbars(), [])
  return null
}
