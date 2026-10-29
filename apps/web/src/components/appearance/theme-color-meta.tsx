import { useEffect } from 'react'

import { useAppearance } from '#/features/appearance/appearance-context'
import { resolveThemeForVariant } from '#/features/appearance/appearance-themes'
import { getThemeTokens } from '@syrnike13/ui/tokens'
import { cssColorToHex } from '#/features/appearance/theme-color-conversion'

export function ThemeColorMeta() {
  const { settings, resolvedVariant } = useAppearance()

  useEffect(() => {
    const tokens = getThemeTokens(
      settings,
      resolvedVariant === 'dark',
      undefined,
      undefined,
      resolveThemeForVariant(settings, resolvedVariant),
    )
    const hex = cssColorToHex(tokens.primary) ?? '#4a3f8f'

    let meta = document.querySelector('meta[name="theme-color"]')
    if (!meta) {
      meta = document.createElement('meta')
      meta.setAttribute('name', 'theme-color')
      document.head.appendChild(meta)
    }
    meta.setAttribute('content', hex)
  }, [resolvedVariant, settings])

  return null
}
