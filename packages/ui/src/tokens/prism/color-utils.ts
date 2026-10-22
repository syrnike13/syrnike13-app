const HEX_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

export function normalizeHex(value: string): string | null {
  const trimmed = value.trim()
  if (!HEX_PATTERN.test(trimmed)) {
    return null
  }
  if (trimmed.length === 4) {
    const [, r, g, b] = trimmed
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }
  return trimmed.toLowerCase()
}

export function parseRgbCss(color: string): { r: number; g: number; b: number } | null {
  const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i)
  if (!match) {
    return null
  }
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
  }
}

export function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (channel: number) => channel.toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const normalized = normalizeHex(hex)
  if (!normalized) {
    return null
  }
  const value = normalized.slice(1)
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  }
}

export function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex)
  if (!rgb) {
    return 0
  }
  const channel = (value: number) => {
    const srgb = value / 255
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b)
}

function canvasColorToHex(color: string): string | null {
  if (typeof document === 'undefined') {
    return null
  }
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const context = canvas.getContext('2d')
  if (!context) {
    return null
  }
  try {
    context.fillStyle = color
    context.fillRect(0, 0, 1, 1)
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data
    return rgbToHex(r, g, b)
  } catch {
    return null
  }
}

/** Best-effort hex for color inputs; falls back to provided value. */
export function cssColorToHex(color: string, fallback = '#000000'): string {
  const normalized = normalizeHex(color)
  if (normalized) {
    return normalized
  }
  if (typeof window === 'undefined') {
    return fallback
  }
  const fromCanvas = canvasColorToHex(color)
  if (fromCanvas) {
    return fromCanvas
  }
  const probe = document.createElement('span')
  probe.style.color = color
  document.body.appendChild(probe)
  const computed = getComputedStyle(probe).color
  probe.remove()
  const rgb = parseRgbCss(computed)
  if (!rgb) {
    return fallback
  }
  return rgbToHex(rgb.r, rgb.g, rgb.b)
}

export function ensureStoredHexColor(color: string | undefined, fallback: string): string {
  if (!color) {
    return normalizeHex(fallback) ?? fallback
  }
  const normalized = normalizeHex(color)
  if (normalized) {
    return normalized
  }
  if (typeof window !== 'undefined') {
    const converted = cssColorToHex(color, '')
    if (converted) {
      return converted
    }
  }
  return normalizeHex(fallback) ?? fallback
}

export function contrastingForeground(accentHex: string): string {
  return relativeLuminance(accentHex) > 0.45 ? '#000000' : '#ffffff'
}

export function mixHex(baseHex: string, mixHexColor: string, mixPercent: number): string {
  const base = hexToRgb(baseHex)
  const mix = hexToRgb(mixHexColor)
  if (!base || !mix) {
    return baseHex
  }
  const ratio = Math.min(100, Math.max(0, mixPercent)) / 100
  return rgbToHex(
    Math.round(base.r + (mix.r - base.r) * ratio),
    Math.round(base.g + (mix.g - base.g) * ratio),
    Math.round(base.b + (mix.b - base.b) * ratio),
  )
}

type Oklab = readonly [number, number, number]

function srgbToLinear(channel: number) {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function linearToSrgb(value: number) {
  const encoded = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055
  return Math.round(Math.min(1, Math.max(0, encoded)) * 255)
}

function hexToOklab(hex: string): Oklab | null {
  const rgb = hexToRgb(hex)
  if (!rgb) {
    return null
  }
  const r = srgbToLinear(rgb.r)
  const g = srgbToLinear(rgb.g)
  const b = srgbToLinear(rgb.b)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function oklabToHex([lightness, a, b]: Oklab): string {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  return rgbToHex(
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  )
}

/** Perceptual lightness (OKLab L, 0–1); equal deltas look equal in light and dark modes. */
export function oklabLightness(hex: string): number {
  return hexToOklab(hex)?.[0] ?? 0
}

/** Mix in OKLab so the same percentage is the same visible step on light and dark bases. */
export function mixOklab(baseHex: string, mixHexColor: string, mixPercent: number): string {
  const base = hexToOklab(baseHex)
  const mix = hexToOklab(mixHexColor)
  if (!base || !mix) {
    return baseHex
  }
  const ratio = Math.min(100, Math.max(0, mixPercent)) / 100
  return oklabToHex([
    base[0] + (mix[0] - base[0]) * ratio,
    base[1] + (mix[1] - base[1]) * ratio,
    base[2] + (mix[2] - base[2]) * ratio,
  ])
}
