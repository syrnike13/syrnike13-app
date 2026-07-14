import { useEffect } from 'react'

import { useAppearance } from '#/features/appearance/appearance-context'
import { getThemeTokens } from '#/features/appearance/theme-registry'
import { cssColorToHex } from '#/features/appearance/theme-color-conversion'

export function ThemeColorMeta() {
  const { settings, resolvedVariant } = useAppearance()

  useEffect(() => {
    const tokens = getThemeTokens(settings, resolvedVariant === 'dark')
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
