import type { CSSProperties } from 'react'

export type TilePalette = {
  from: string
  to: string
}

const FALLBACK_PALETTES: TilePalette[] = [
  { from: '#3a4a2e', to: '#2a3324' },
  { from: '#2e3a4a', to: '#242a33' },
  { from: '#4a2e3a', to: '#332428' },
  { from: '#3a2e4a', to: '#2a2433' },
]

const paletteCache = new Map<string, TilePalette>()
const LOAD_TIMEOUT_MS = 8_000

export function fallbackTilePalette(seed: string): TilePalette {
  let hash = 0
  for (let index = 0; index < seed.length; index++) {
    hash = (hash + seed.charCodeAt(index)) % FALLBACK_PALETTES.length
  }
  return FALLBACK_PALETTES[hash]!
}

export function getCachedTilePalette(avatarId: string) {
  return paletteCache.get(avatarId)
}

export function tilePaletteStyle(palette: TilePalette): CSSProperties {
  return {
    backgroundImage: `linear-gradient(to bottom right, ${palette.from}, ${palette.to})`,
  }
}

export async function loadAvatarTilePalette(
  avatarId: string,
  url: string,
): Promise<TilePalette | null> {
  const cached = paletteCache.get(avatarId)
  if (cached) return cached

  const extracted = await extractPaletteFromImageUrl(url)
  if (extracted) paletteCache.set(avatarId, extracted)
  return extracted
}

async function extractPaletteFromImageUrl(
  url: string,
): Promise<TilePalette | null> {
  try {
    const image = await loadImage(url)
    return extractPaletteFromImage(image)
  } catch {
    return null
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.decoding = 'async'

    const timer = window.setTimeout(() => {
      reject(new Error('avatar palette load timeout'))
    }, LOAD_TIMEOUT_MS)

    image.onload = () => {
      window.clearTimeout(timer)
      resolve(image)
    }
    image.onerror = () => {
      window.clearTimeout(timer)
      reject(new Error('avatar palette load failed'))
    }
    image.src = url
  })
}

function extractPaletteFromImage(image: HTMLImageElement): TilePalette | null {
  const size = 48
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null

  context.drawImage(image, 0, 0, size, size)
  let data: ImageData
  try {
    data = context.getImageData(0, 0, size, size)
  } catch {
    return null
  }

  const dominant = extractDominantRgb(data.data)
  if (!dominant) return null
  return paletteFromRgb(dominant.r, dominant.g, dominant.b)
}

function extractDominantRgb(pixels: Uint8ClampedArray) {
  let rSum = 0
  let gSum = 0
  let bSum = 0
  let weight = 0

  for (let index = 0; index < pixels.length; index += 4) {
    const r = pixels[index]!
    const g = pixels[index + 1]!
    const b = pixels[index + 2]!
    const a = pixels[index + 3]!
    if (a < 96) continue

    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const saturation = max === 0 ? 0 : (max - min) / max
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255

    if (saturation < 0.14 || luminance < 0.07 || luminance > 0.93) continue

    const pixelWeight =
      saturation * (1 - Math.min(1, Math.abs(luminance - 0.42) * 1.35))
    rSum += r * pixelWeight
    gSum += g * pixelWeight
    bSum += b * pixelWeight
    weight += pixelWeight
  }

  if (weight < 0.5) return null

  return {
    r: Math.round(rSum / weight),
    g: Math.round(gSum / weight),
    b: Math.round(bSum / weight),
  }
}

export function paletteFromRgb(r: number, g: number, b: number): TilePalette {
  const [h, s, l] = rgbToHsl(r, g, b)
  const from = hslToHex(
    h,
    clamp(s * 1.08, 0.28, 0.92),
    clamp(l * 1.18 + 0.06, 0.28, 0.52),
  )
  const to = hslToHex(
    h,
    clamp(s * 0.92, 0.22, 0.85),
    clamp(l * 0.52, 0.1, 0.28),
  )
  return { from, to }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const delta = max - min
  let h = 0
  const l = (max + min) / 2
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1))

  if (delta !== 0) {
    switch (max) {
      case rn:
        h = ((gn - bn) / delta + (gn < bn ? 6 : 0)) / 6
        break
      case gn:
        h = ((bn - rn) / delta + 2) / 6
        break
      default:
        h = ((rn - gn) / delta + 4) / 6
        break
    }
  }

  return [h, s, l]
}

function hslToHex(h: number, s: number, l: number) {
  const [r, g, b] = hslToRgb(h, s, l)
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const gray = Math.round(l * 255)
    return [gray, gray, gray]
  }

  const hue = ((h % 1) + 1) % 1
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q

  return [
    Math.round(hueToChannel(p, q, hue + 1 / 3) * 255),
    Math.round(hueToChannel(p, q, hue) * 255),
    Math.round(hueToChannel(p, q, hue - 1 / 3) * 255),
  ]
}

function hueToChannel(p: number, q: number, t: number) {
  let channel = t
  if (channel < 0) channel += 1
  if (channel > 1) channel -= 1
  if (channel < 1 / 6) return p + (q - p) * 6 * channel
  if (channel < 1 / 2) return q
  if (channel < 2 / 3) return p + (q - p) * (2 / 3 - channel) * 6
  return p
}

function toHex(channel: number) {
  return channel.toString(16).padStart(2, '0')
}
