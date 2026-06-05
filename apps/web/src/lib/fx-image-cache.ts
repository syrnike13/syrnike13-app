/** localStorage: `syrnike13.fx-image.force-loader` = `1` — тест мозаики (см. `window.__fxImage`). */
export const FX_IMAGE_FORCE_LOADER_KEY = 'syrnike13.fx-image.force-loader'

/** Минимум времени мозаики в тестовом режиме (мс). */
export const FX_IMAGE_FORCE_MIN_SHADER_MS = 1_200

declare global {
  interface Window {
    __fxImage?: {
      enable: () => void
      disable: () => void
      enabled: () => boolean
    }
  }
}

export function registerFxImageDebug() {
  if (typeof window === 'undefined') return
  window.__fxImage = {
    enable: () => {
      localStorage.setItem(FX_IMAGE_FORCE_LOADER_KEY, '1')
      console.info(
        '[FxImage] тест мозаики включён — перезагрузите страницу (F5)',
      )
    },
    disable: () => {
      localStorage.removeItem(FX_IMAGE_FORCE_LOADER_KEY)
      console.info('[FxImage] тест мозаики выключен — перезагрузите страницу')
    },
    enabled: shouldForceFxLoader,
  }
}

/** Принудительный прогон эффекта (localStorage, без привязки к DEV). */
export function shouldForceFxLoader(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return localStorage.getItem(FX_IMAGE_FORCE_LOADER_KEY) === '1'
  } catch {
    return false
  }
}

/** URL без disk cache — только в тестовом режиме. */
export function fxImageNetworkUrl(src: string): string {
  if (!shouldForceFxLoader()) return src
  try {
    const url = new URL(src, window.location.href)
    url.searchParams.set('_fx', String(Date.now()))
    return url.href
  } catch {
    const sep = src.includes('?') ? '&' : '?'
    return `${src}${sep}_fx=${Date.now()}`
  }
}

/** Браузер уже держит декодированное изображение (память / HTTP-кеш). */
export function isImageCached(src: string): boolean {
  if (shouldForceFxLoader()) return false
  if (typeof window === 'undefined' || !src) return false
  const probe = new Image()
  probe.src = src
  return probe.complete && probe.naturalWidth > 0
}

/** Сразу после `img.src = url` — дисковый/HTTP-кеш часто отдаёт кадр синхронно. */
export function isImageComplete(img: HTMLImageElement): boolean {
  if (shouldForceFxLoader()) return false
  return img.complete && img.naturalWidth > 0
}
