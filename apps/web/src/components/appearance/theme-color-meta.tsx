import { useEffect } from 'react'

import { useAppearance } from '#/features/appearance/appearance-context'
import { getThemeTokens } from '#/features/appearance/theme-registry'

function oklchToHex(value: string): string | null {
  const match = value.match(
    /oklch\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*\)/i,
  )
  if (!match) return null

  const l = Number(match[1])
  const c = Number(match[2])
  const h = (Number(match[3]) * Math.PI) / 180
  const a = c * Math.cos(h)
  const b = c * Math.sin(h)

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b
  const s_ = l - 0.0894841775 * a - 1.291485548 * b

  const l3 = l_ * l_ * l_
  const m3 = m_ * m_ * m_
  const s3 = s_ * s_ * s_

  let r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3
  let g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3
  let bch = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3

  const clamp = (channel: number) =>
    Math.round(Math.min(255, Math.max(0, channel * 255)))

  const toHex = (channel: number) => clamp(channel).toString(16).padStart(2, '0')

  return `#${toHex(r)}${toHex(g)}${toHex(bch)}`
}

export function ThemeColorMeta() {
  const { settings, resolvedVariant } = useAppearance()

  useEffect(() => {
    const tokens = getThemeTokens(settings, resolvedVariant === 'dark')
    const hex = oklchToHex(tokens.primary) ?? '#4a3f8f'

    let meta = document.querySelector('meta[name="theme-color"]')
    if (!meta) {
      meta = document.createElement('meta')
      meta.setAttribute('name', 'theme-color')
      document.head.appendChild(meta)
    }
    meta.setAttribute('content', hex)
  }, [settings.themeId, resolvedVariant])

  return null
}
