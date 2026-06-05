import { setFrameRate, setMaxDpr } from 'img-fx'

import { registerFxImageDebug } from '#/lib/fx-image-cache.ts'

let initialized = false

/** Глобальные настройки img-fx для всего приложения. */
export function initImgFx() {
  if (initialized || typeof window === 'undefined') return
  initialized = true
  setFrameRate(10)
  setMaxDpr(2)
  registerFxImageDebug()
}
