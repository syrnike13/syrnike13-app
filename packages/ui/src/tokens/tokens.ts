import type { PrismTokens } from './prism'
import type { ThemeVariant } from './types'

export const THEME_TOKEN_KEYS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'hover',
  'hover-foreground',
  'selection',
  'selection-foreground',
  'destructive',
  'destructive-foreground',
  'destructive-contrast',
  'border',
  'input',
  'input-border',
  'ring',
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'sidebar',
  'sidebar-foreground',
  'sidebar-primary',
  'sidebar-primary-foreground',
  'sidebar-accent',
  'sidebar-accent-foreground',
  'sidebar-border',
  'shell-divider',
  'divider',
  'surface-raised',
  'surface-raised-foreground',
  'disabled-foreground',
  'sidebar-ring',
  'scrollbar-thumb',
  'scrollbar-thumb-hover',
] as const

export type ThemeTokenKey = (typeof THEME_TOKEN_KEYS)[number]
export type ThemeTokens = Record<ThemeTokenKey, string>

/** Brand colors never come from the theme anchors; they are fixed exceptions. */
export const BRAND_LOCKED_THEME_TOKEN_KEYS = [
  'primary',
  'primary-foreground',
  'destructive',
  'destructive-foreground',
  'destructive-contrast',
  'ring',
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
] as const satisfies readonly ThemeTokenKey[]

type BrandTokens = Pick<
  ThemeTokens,
  (typeof BRAND_LOCKED_THEME_TOKEN_KEYS)[number]
>

const BRAND_PRIMARY = 'oklch(0.5774 0.2091 273.8504)'
const BRAND_DESTRUCTIVE = 'oklch(0.7040 0.1910 22.2160)'

export const BRAND_THEME_TOKENS: Record<ThemeVariant, BrandTokens> = {
  light: {
    primary: BRAND_PRIMARY,
    'primary-foreground': 'oklch(1 0 0)',
    destructive: BRAND_DESTRUCTIVE,
    'destructive-foreground': 'oklch(1 0 0)',
    'destructive-contrast': 'oklch(0.5156 0.1810 22.5393)',
    ring: BRAND_PRIMARY,
    'chart-1': 'oklch(0.8092 0.1122 345.1956)',
    'chart-2': 'oklch(0.8757 0.0979 83.6546)',
    'chart-3': 'oklch(0.9075 0.0946 165.0540)',
    'chart-4': 'oklch(0.8406 0.0699 242.1914)',
    'chart-5': 'oklch(0.7865 0.1232 309.4396)',
  },
  dark: {
    primary: BRAND_PRIMARY,
    'primary-foreground': 'oklch(1 0 0)',
    destructive: BRAND_DESTRUCTIVE,
    'destructive-foreground': 'oklch(1 0 0)',
    'destructive-contrast': 'oklch(63.7% 0.237 25.331)',
    ring: BRAND_PRIMARY,
    'chart-1': 'oklch(0.8092 0.1122 345.1956)',
    'chart-2': 'oklch(0.8757 0.0979 83.6546)',
    'chart-3': 'oklch(0.9075 0.0946 165.0540)',
    'chart-4': 'oklch(0.8406 0.0699 242.1914)',
    'chart-5': 'oklch(0.7865 0.1232 309.4396)',
  },
}

function scrollbarTokens(
  variant: ThemeVariant,
): Pick<ThemeTokens, 'scrollbar-thumb' | 'scrollbar-thumb-hover'> {
  return variant === 'dark'
    ? {
        'scrollbar-thumb': 'rgb(255 255 255 / 0.22)',
        'scrollbar-thumb-hover': 'rgb(255 255 255 / 0.38)',
      }
    : {
        'scrollbar-thumb': 'rgb(0 0 0 / 0.22)',
        'scrollbar-thumb-hover': 'rgb(0 0 0 / 0.36)',
      }
}

function prismValue(tokens: PrismTokens, name: string): string {
  return tokens[`--${name}` as keyof PrismTokens] ?? ''
}

/** Adapter from Prism's semantic roles to the app's stable CSS contract. */
export function prismTokensToThemeTokens(
  tokens: PrismTokens,
  variant: ThemeVariant,
): ThemeTokens {
  return {
    background: prismValue(tokens, 'background'),
    foreground: prismValue(tokens, 'foreground'),
    card: prismValue(tokens, 'card'),
    'card-foreground': prismValue(tokens, 'card-foreground'),
    popover: prismValue(tokens, 'popover'),
    'popover-foreground': prismValue(tokens, 'popover-foreground'),
    ...BRAND_THEME_TOKENS[variant],
    secondary: prismValue(tokens, 'secondary'),
    'secondary-foreground': prismValue(tokens, 'secondary-foreground'),
    muted: prismValue(tokens, 'muted'),
    'muted-foreground': prismValue(tokens, 'muted-foreground'),
    accent: prismValue(tokens, 'accent'),
    'accent-foreground': prismValue(tokens, 'accent-foreground'),
    hover: prismValue(tokens, 'hover'),
    'hover-foreground': prismValue(tokens, 'hover-foreground'),
    selection: prismValue(tokens, 'selection'),
    'selection-foreground': prismValue(tokens, 'selection-foreground'),
    border: prismValue(tokens, 'border'),
    input: prismValue(tokens, 'input'),
    'input-border': prismValue(tokens, 'input-border'),
    sidebar: prismValue(tokens, 'sidebar'),
    'sidebar-foreground': prismValue(tokens, 'sidebar-foreground'),
    'sidebar-primary': prismValue(tokens, 'sidebar-primary'),
    'sidebar-primary-foreground': prismValue(tokens, 'sidebar-primary-foreground'),
    'sidebar-accent': prismValue(tokens, 'sidebar-accent'),
    'sidebar-accent-foreground': prismValue(tokens, 'sidebar-accent-foreground'),
    'sidebar-border': prismValue(tokens, 'sidebar-border'),
    'shell-divider': prismValue(tokens, 'divider'),
    divider: prismValue(tokens, 'divider'),
    'surface-raised': prismValue(tokens, 'surface-raised'),
    'surface-raised-foreground': prismValue(tokens, 'surface-raised-foreground'),
    'disabled-foreground': prismValue(tokens, 'disabled-foreground'),
    'sidebar-ring': prismValue(tokens, 'sidebar-ring'),
    ...scrollbarTokens(variant),
  }
}
