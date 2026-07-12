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
  'destructive',
  'destructive-foreground',
  'destructive-soft',
  'border',
  'input',
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
  'sidebar-ring',
  'scrollbar-thumb',
  'scrollbar-thumb-hover',
] as const

export type ThemeTokenKey = (typeof THEME_TOKEN_KEYS)[number]
export type ThemeTokens = Record<ThemeTokenKey, string>

/** Не меняются при смене темы — всегда из палитры СЫРНИКИ (light/dark). */
export const BRAND_LOCKED_THEME_TOKEN_KEYS = [
  'primary',
  'primary-foreground',
  'destructive',
  'destructive-foreground',
  'destructive-soft',
  'ring',
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
] as const satisfies readonly ThemeTokenKey[]

export type BrandLockedThemeTokenKey = (typeof BRAND_LOCKED_THEME_TOKEN_KEYS)[number]

export type ThemeSemanticPalette = {
  background: string
  foreground: string
  card: string
  primary: string
  primaryForeground: string
  secondary: string
  secondaryForeground: string
  muted: string
  mutedForeground: string
  accent: string
  accentForeground: string
  destructive: string
  destructiveForeground: string
  destructiveSoft: string
  border: string
  input: string
  ring: string
  chart1: string
  chart2: string
  chart3: string
  chart4: string
  chart5: string
  sidebar: string
  sidebarForeground: string
  sidebarPrimary: string
  sidebarPrimaryForeground: string
  sidebarAccent: string
  sidebarAccentForeground: string
  sidebarBorder: string
  shellDivider: string
  sidebarRing: string
  scrollbarThumb: string
  scrollbarThumbHover: string
}

export type ShadcnColorVariables = {
  background: string
  foreground: string
  card: string
  cardForeground: string
  popover: string
  popoverForeground: string
  primary: string
  primaryForeground: string
  secondary: string
  secondaryForeground: string
  muted: string
  mutedForeground: string
  accent: string
  accentForeground: string
  destructive: string
  destructiveForeground: string
  destructiveSoft: string
  border: string
  input: string
  ring: string
  chart1: string
  chart2: string
  chart3: string
  chart4: string
  chart5: string
  sidebar: string
  sidebarForeground: string
  sidebarPrimary: string
  sidebarPrimaryForeground: string
  sidebarAccent: string
  sidebarAccentForeground: string
  sidebarBorder: string
  sidebarRing: string
  shellDivider?: string
}

function scrollbarTokens(isDark: boolean): Pick<ThemeTokens, 'scrollbar-thumb' | 'scrollbar-thumb-hover'> {
  return isDark
    ? {
        'scrollbar-thumb': 'rgb(255 255 255 / 0.22)',
        'scrollbar-thumb-hover': 'rgb(255 255 255 / 0.38)',
      }
    : {
        'scrollbar-thumb': 'rgb(0 0 0 / 0.22)',
        'scrollbar-thumb-hover': 'rgb(0 0 0 / 0.36)',
      }
}

export function createThemeTokens(
  colors: ShadcnColorVariables,
  isDark: boolean,
): ThemeTokens {
  const shellDivider = colors.shellDivider ?? colors.border
  return {
    background: colors.background,
    foreground: colors.foreground,
    card: colors.card,
    'card-foreground': colors.cardForeground,
    popover: colors.popover,
    'popover-foreground': colors.popoverForeground,
    primary: colors.primary,
    'primary-foreground': colors.primaryForeground,
    secondary: colors.secondary,
    'secondary-foreground': colors.secondaryForeground,
    muted: colors.muted,
    'muted-foreground': colors.mutedForeground,
    accent: colors.accent,
    'accent-foreground': colors.accentForeground,
    destructive: colors.destructive,
    'destructive-foreground': colors.destructiveForeground,
    'destructive-soft': colors.destructiveSoft,
    border: colors.border,
    input: colors.input,
    ring: colors.ring,
    'chart-1': colors.chart1,
    'chart-2': colors.chart2,
    'chart-3': colors.chart3,
    'chart-4': colors.chart4,
    'chart-5': colors.chart5,
    sidebar: colors.sidebar,
    'sidebar-foreground': colors.sidebarForeground,
    'sidebar-primary': colors.sidebarPrimary,
    'sidebar-primary-foreground': colors.sidebarPrimaryForeground,
    'sidebar-accent': colors.sidebarAccent,
    'sidebar-accent-foreground': colors.sidebarAccentForeground,
    'sidebar-border': colors.sidebarBorder,
    'shell-divider': shellDivider,
    'sidebar-ring': colors.sidebarRing,
    ...scrollbarTokens(isDark),
  }
}

export function buildThemeTokens(palette: ThemeSemanticPalette): ThemeTokens {
  return {
    background: palette.background,
    foreground: palette.foreground,
    card: palette.card,
    'card-foreground': palette.foreground,
    popover: palette.card,
    'popover-foreground': palette.foreground,
    primary: palette.primary,
    'primary-foreground': palette.primaryForeground,
    secondary: palette.secondary,
    'secondary-foreground': palette.secondaryForeground,
    muted: palette.muted,
    'muted-foreground': palette.mutedForeground,
    accent: palette.accent,
    'accent-foreground': palette.accentForeground,
    destructive: palette.destructive,
    'destructive-foreground': palette.destructiveForeground,
    'destructive-soft': palette.destructiveSoft,
    border: palette.border,
    input: palette.input,
    ring: palette.ring,
    'chart-1': palette.chart1,
    'chart-2': palette.chart2,
    'chart-3': palette.chart3,
    'chart-4': palette.chart4,
    'chart-5': palette.chart5,
    sidebar: palette.sidebar,
    'sidebar-foreground': palette.sidebarForeground,
    'sidebar-primary': palette.sidebarPrimary,
    'sidebar-primary-foreground': palette.sidebarPrimaryForeground,
    'sidebar-accent': palette.sidebarAccent,
    'sidebar-accent-foreground': palette.sidebarAccentForeground,
    'sidebar-border': palette.sidebarBorder,
    'shell-divider': palette.shellDivider,
    'sidebar-ring': palette.sidebarRing,
    'scrollbar-thumb': palette.scrollbarThumb,
    'scrollbar-thumb-hover': palette.scrollbarThumbHover,
  }
}
