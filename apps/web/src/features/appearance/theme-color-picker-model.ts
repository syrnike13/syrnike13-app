/** HSV coordinates belong to the color picker, not Prism's theme generation. */
export type PickerHsv = { hue: number; saturation: number; brightness: number }

export function normalizePickerHex(value: string): string | null {
  const hex = value.trim().replace(/^#/, '')
  if (/^[\da-f]{6}$/i.test(hex)) return `#${hex.toUpperCase()}`
  if (/^[\da-f]{3}$/i.test(hex)) {
    return `#${[...hex]
      .map((channel) => channel.repeat(2))
      .join('')
      .toUpperCase()}`
  }
  return null
}

export function hexToPickerHsv(value: string, previousHue = 0): PickerHsv {
  const hex = normalizePickerHex(value)!
  const [red, green, blue] = [1, 3, 5].map(
    (start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255,
  ) as [number, number, number]
  const high = Math.max(red, green, blue)
  const low = Math.min(red, green, blue)
  const delta = high - low
  let hue = previousHue
  if (delta > 0) {
    const sector =
      high === red
        ? (green - blue) / delta
        : high === green
          ? (blue - red) / delta + 2
          : (red - green) / delta + 4
    hue = (sector * 60 + 360) % 360
  }
  return { hue, saturation: high === 0 ? 0 : delta / high, brightness: high }
}

export function pickerHsvToHex({
  hue,
  saturation,
  brightness,
}: PickerHsv): string {
  const chroma = brightness * saturation
  const sector = (((hue % 360) + 360) % 360) / 60
  const secondary = chroma * (1 - Math.abs((sector % 2) - 1))
  const channels =
    sector < 1
      ? [chroma, secondary, 0]
      : sector < 2
        ? [secondary, chroma, 0]
        : sector < 3
          ? [0, chroma, secondary]
          : sector < 4
            ? [0, secondary, chroma]
            : sector < 5
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary]
  const offset = brightness - chroma
  return `#${channels
    .map((channel) =>
      Math.round((channel + offset) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
    .toUpperCase()}`
}

export const PICKER_HUE_SPECTRUM = `linear-gradient(to right, ${[
  0, 60, 120, 180, 240, 300, 360,
]
  .map((hue) => pickerHsvToHex({ hue, saturation: 1, brightness: 1 }))
  .join(', ')})`
