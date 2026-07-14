function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function linearToSrgb(channel: number): number {
  if (channel <= 0.0031308) return 12.92 * channel
  return 1.055 * channel ** (1 / 2.4) - 0.055
}

function channelToHex(channel: number): string {
  return Math.round(clamp(linearToSrgb(channel), 0, 1) * 255)
    .toString(16)
    .padStart(2, '0')
}

function oklchToHex(value: string): string | null {
  const match = value.match(
    /oklch\(\s*([0-9.]+%?)\s+([0-9.]+)\s+([0-9.]+)/i,
  )
  if (!match) return null

  const lightness = match[1]!.endsWith('%')
    ? Number.parseFloat(match[1]!) / 100
    : Number(match[1])
  const chroma = Number(match[2])
  const hue = (Number(match[3]) * Math.PI) / 180
  if (![lightness, chroma, hue].every(Number.isFinite)) return null

  const a = chroma * Math.cos(hue)
  const b = chroma * Math.sin(hue)
  const l = lightness + 0.3963377774 * a + 0.2158037573 * b
  const m = lightness - 0.1055613458 * a - 0.0638541728 * b
  const s = lightness - 0.0894841775 * a - 1.291485548 * b
  const l3 = l * l * l
  const m3 = m * m * m
  const s3 = s * s * s

  const red = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3
  const green = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3
  const blue = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3

  return `#${channelToHex(red)}${channelToHex(green)}${channelToHex(blue)}`.toUpperCase()
}

function rgbToHex(value: string): string | null {
  const match = value.match(
    /rgb\(\s*([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)/i,
  )
  if (!match) return null
  const channels = match.slice(1, 4).map(Number)
  if (!channels.every(Number.isFinite)) return null
  return `#${channels
    .map((channel) => Math.round(clamp(channel, 0, 255)).toString(16).padStart(2, '0'))
    .join('')}`.toUpperCase()
}

export function cssColorToHex(value: string): string | null {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toUpperCase()
  return oklchToHex(value) ?? rgbToHex(value)
}
