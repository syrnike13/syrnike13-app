import { generatePrismTokens } from './prism-generator.js'
import type { PrismTheme, PrismVariants, ThemeMode, ThemeVariant } from './types.js'

export function resolvePrismMode(mode: ThemeMode): ThemeVariant {
  if (mode !== 'system') return mode
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

export function getPrismAttributes(mode: ThemeVariant, themeMode: ThemeMode = mode) {
  return {
    'data-style-preset': 'prism',
    'data-theme-mode': themeMode,
    'data-theme-resolved': mode,
  } as const
}

/** Apply the same palette during the pre-paint bootstrap and later updates. */
export function applyPrismTheme(root: HTMLElement, theme: PrismTheme, mode: ThemeVariant) {
  root.dataset.stylePreset = 'prism'
  root.dataset.themeMode = theme.mode
  root.dataset.themeResolved = mode
  root.style.colorScheme = mode
  root.classList.toggle('dark', mode === 'dark')
  for (const [name, value] of Object.entries(generatePrismTokens(theme[mode], mode))) {
    root.style.setProperty(name, value)
  }
}

/** Fixed themes can render all colors in the initial HTML without a bootstrap script. */
export function getPrismCss(variants: PrismVariants, defaultMode: ThemeVariant) {
  return (['light', 'dark'] as const).map(mode => {
    const selector = mode === defaultMode
      ? `:root, :root[data-theme-resolved="${mode}"]`
      : `:root[data-theme-resolved="${mode}"]`
    const declarations = Object.entries(generatePrismTokens(variants[mode], mode))
      .map(([name, value]) => `${name}:${value};`).join('')
    return `${selector}{color-scheme:${mode};${declarations}}`
  }).join('\n')
}
