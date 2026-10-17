import type { ThemeVariant, PrismAnchors } from './types.js'

export const DEFAULT_PRISM_VARIANTS: Record<ThemeVariant, PrismAnchors> = {
  light: {
    accent: '#18181b',
    background: '#ffffff',
    foreground: '#09090b',
    contrast: 45,
  },
  dark: {
    accent: '#fafafa',
    background: '#09090b',
    foreground: '#fafafa',
    contrast: 60,
  },
}

export function createDefaultPrismVariants() {
  return {
    light: { ...DEFAULT_PRISM_VARIANTS.light },
    dark: { ...DEFAULT_PRISM_VARIANTS.dark },
  }
}
