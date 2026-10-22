import { useEffect, useState } from 'react'

type Rgb = readonly [number, number, number]
type ToneStop = readonly [position: number, color: Rgb]

export type TonedIcon = {
  src: string
  /** Мелкий пиксель-арт увеличиваем без сглаживания. */
  pixelated: boolean
}

const LOAD_TIMEOUT_MS = 8_000
const PIXELATED_MAX_SIZE = 64
const toneCache = new Map<string, Promise<TonedIcon | null>>()

function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  return [
    Math.round(from[0] + (to[0] - from[0]) * amount),
    Math.round(from[1] + (to[1] - from[1]) * amount),
    Math.round(from[2] + (to[2] - from[2]) * amount),
  ]
}

/** Шкала от тёмной бронзы до светлой; светлый конец не уходит в белый. */
export function buildToneRamp(base: Rgb): ToneStop[] {
  return [
    [0, mix(base, [0, 0, 0], 0.78)],
    [0.3, mix(base, [0, 0, 0], 0.48)],
    [0.6, mix(base, [0, 0, 0], 0.18)],
    [0.85, base],
    [1, mix(base, [255, 255, 255], 0.3)],
  ]
}

function sampleRamp(ramp: ToneStop[], t: number): Rgb {
  for (let index = 1; index < ramp.length; index++) {
    const [from, fromColor] = ramp[index - 1]!
    const [to, toColor] = ramp[index]!
    if (t <= to) return mix(fromColor, toColor, (t - from) / (to - from))
  }
  return ramp[ramp.length - 1]![1]
}

function luminance(pixels: Uint8ClampedArray, index: number) {
  return (
    0.299 * pixels[index]! + 0.587 * pixels[index + 1]! + 0.114 * pixels[index + 2]!
  )
}

/**
 * Перекрашивает непрозрачные пиксели по яркости в бронзу.
 * Диапазон яркости берётся из самой иконки, поэтому тёмные и светлые
 * иконки одинаково получают полный контраст, а светлые места не пересвечиваются.
 */
export function toneMapPixels(pixels: Uint8ClampedArray, ramp: ToneStop[]) {
  const levels: number[] = []
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3]! > 0) levels.push(luminance(pixels, index))
  }
  if (levels.length === 0) return

  levels.sort((a, b) => a - b)
  const low = levels[Math.floor(levels.length * 0.03)]!
  const high = levels[Math.floor(levels.length * 0.97)]!
  const range = Math.max(1, high - low)

  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] === 0) continue
    const t = Math.min(1, Math.max(0, (luminance(pixels, index) - low) / range))
    const [r, g, b] = sampleRamp(ramp, t ** 1.1)
    pixels[index] = r
    pixels[index + 1] = g
    pixels[index + 2] = b
  }
}

/** Цвет токена `--achievement` в RGB (браузер сам переводит oklch). */
function readAchievementColor(): Rgb | null {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue('--achievement')
    .trim()
  if (!value) return null

  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null

  context.fillStyle = value
  context.fillRect(0, 0, 1, 1)
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data
  return [r!, g!, b!]
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    const timer = window.setTimeout(() => reject(new Error('timeout')), LOAD_TIMEOUT_MS)
    image.crossOrigin = 'anonymous'
    image.decoding = 'async'
    image.onload = () => {
      window.clearTimeout(timer)
      resolve(image)
    }
    image.onerror = () => {
      window.clearTimeout(timer)
      reject(new Error('load failed'))
    }
    image.src = url
  })
}

async function toneIcon(url: string, base: Rgb): Promise<TonedIcon | null> {
  const image = await loadImage(url)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context || canvas.width === 0 || canvas.height === 0) return null

  context.drawImage(image, 0, 0)
  const data = context.getImageData(0, 0, canvas.width, canvas.height)
  toneMapPixels(data.data, buildToneRamp(base))
  context.putImageData(data, 0, 0)
  return {
    src: canvas.toDataURL(),
    pixelated: Math.max(canvas.width, canvas.height) <= PIXELATED_MAX_SIZE,
  }
}

function toneAchievementIcon(url: string): Promise<TonedIcon | null> {
  const base = readAchievementColor()
  if (!base) return Promise.resolve(null)

  const key = `${base.join(',')}|${url}`
  let toned = toneCache.get(key)
  if (!toned) {
    toned = toneIcon(url, base).catch(() => null)
    toneCache.set(key, toned)
  }
  return toned
}

/**
 * Иконка бейджа в бронзе.
 * `undefined` — ещё готовится; `null` — перекрасить не вышло, показываем оригинал.
 */
export function useAchievementIconTone(url: string | null) {
  const [state, setState] = useState<{ url: string; toned: TonedIcon | null }>()

  useEffect(() => {
    if (!url) return
    let active = true
    void toneAchievementIcon(url).then((toned) => {
      if (active) setState({ url, toned })
    })
    return () => {
      active = false
    }
  }, [url])

  if (!url) return null
  return state?.url === url ? state.toned : undefined
}
