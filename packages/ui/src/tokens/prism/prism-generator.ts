import {
  contrastingForeground,
  mixHex,
  mixOklab,
  normalizeHex,
  oklabLightness,
  relativeLuminance,
} from './color-utils.js'
import { DEFAULT_CONTRAST, MAX_CONTRAST, MIN_CONTRAST, type ThemeVariant } from './types.js'
import { DEFAULT_PRISM_VARIANTS } from './prism-defaults.js'

import type { PrismAnchors, PrismTokens } from './types.js'

/**
 * OKLab mix percentages toward the foreground. The same amount is the same visible step in
 * light and dark mode, so one table serves both.
 */
const SURFACE_MIX = {
  card: 8,
  popover: 12,
  secondary: 14,
  muted: 9,
  input: 8,
  sidebar: 6,
  border: 18,
  accent: 17,
  hover: 10,
  selection: 18,
} as const

const RAISED_MIX = { light: 14, dark: 5 } as const

/**
 * Minimum OKLab lightness gap between an interaction fill and every neutral surface it can sit
 * on (background, card, popover, sidebar, raised), so hover never vanishes on one of them.
 */
const MIN_INTERACTION_DELTA = { accent: 0.045, hover: 0.07 } as const

export type PrismSurfaceMixKey = keyof typeof SURFACE_MIX
export type PrismInteractionDeltaKey = keyof typeof MIN_INTERACTION_DELTA

export type PrismTuning = {
  surfaceMix: Record<PrismSurfaceMixKey, number>
  raisedMix: Record<ThemeVariant, number>
  minInteractionDelta: Record<PrismInteractionDeltaKey, number>
}

export type PrismTuningPatch = {
  surfaceMix?: Partial<PrismTuning['surfaceMix']>
  raisedMix?: Partial<PrismTuning['raisedMix']>
  minInteractionDelta?: Partial<PrismTuning['minInteractionDelta']>
}

export const DEFAULT_PRISM_TUNING: PrismTuning = {
  surfaceMix: { ...SURFACE_MIX },
  raisedMix: { ...RAISED_MIX },
  minInteractionDelta: { ...MIN_INTERACTION_DELTA },
}

function clampTuning(value: number, min: number, max: number) {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min
}

function resolveTuning(patch?: PrismTuningPatch): PrismTuning {
  const surfaceMix = { ...SURFACE_MIX, ...patch?.surfaceMix }
  const raisedMix = { ...RAISED_MIX, ...patch?.raisedMix }
  const minInteractionDelta = {
    ...MIN_INTERACTION_DELTA,
    ...patch?.minInteractionDelta,
  }

  return {
    surfaceMix: Object.fromEntries(
      Object.entries(surfaceMix).map(([key, value]) => [
        key,
        clampTuning(value, 0, 60),
      ]),
    ) as PrismTuning['surfaceMix'],
    raisedMix: {
      light: clampTuning(raisedMix.light, 0, 60),
      dark: clampTuning(raisedMix.dark, 0, 60),
    },
    minInteractionDelta: {
      accent: clampTuning(minInteractionDelta.accent, 0, 0.3),
      hover: clampTuning(minInteractionDelta.hover, 0, 0.3),
    },
  }
}

function validHex(value: string, fallback: string) {
  return normalizeHex(value) ?? fallback
}

function validContrast(value: number, mode: ThemeVariant) {
  if (!Number.isFinite(value)) return DEFAULT_CONTRAST[mode]
  return Math.max(MIN_CONTRAST, Math.min(MAX_CONTRAST, value))
}

function contrastMix(amount: number, contrast: number, mode: ThemeVariant) {
  const baseline = DEFAULT_CONTRAST[mode]
  const factor = contrast <= baseline
    ? 0.5 + 0.5 * (contrast / baseline)
    : 1 + 0.5 * ((contrast - baseline) / (100 - baseline))
  return amount * factor
}

/** Interaction states follow contrast too, but never fade out at the low end of the slider. */
function interactionMix(amount: number, contrast: number, mode: ThemeVariant) {
  return Math.max(contrastMix(amount, contrast, mode), amount * 0.75)
}

/** Push a fill toward the foreground until it clears every surface by `minDelta`. */
function separatedFill(
  background: string,
  foreground: string,
  amount: number,
  surfaces: readonly string[],
  minDelta: number,
) {
  const gap = (fill: string) => Math.min(
    ...surfaces.map(surface => Math.abs(oklabLightness(fill) - oklabLightness(surface))),
  )
  let mix = amount
  let fill = mixOklab(background, foreground, mix)
  while (gap(fill) < minDelta && mix < 60) {
    mix += 1
    fill = mixOklab(background, foreground, mix)
  }
  return fill
}

function contrastRatio(a: string, b: string) {
  const lighter = Math.max(relativeLuminance(a), relativeLuminance(b))
  const darker = Math.min(relativeLuminance(a), relativeLuminance(b))
  return (lighter + 0.05) / (darker + 0.05)
}

function readableForeground(preferred: string, surface: string) {
  if (contrastRatio(preferred, surface) >= 4.5) return preferred
  const black = '#000000'
  const white = '#ffffff'
  return contrastRatio(black, surface) >= contrastRatio(white, surface) ? black : white
}

function normalizeBackground(value: string, mode: ThemeVariant) {
  const luminance = relativeLuminance(value)
  if (mode === 'light' && luminance < 0.35) return mixHex(value, '#ffffff', 72)
  if (mode === 'dark' && luminance > 0.65) return mixHex(value, '#000000', 72)
  return value
}

function normalizeForeground(value: string, mode: ThemeVariant) {
  const luminance = relativeLuminance(value)
  if (mode === 'light' && luminance > 0.8) return mixHex(value, '#000000', 72)
  if (mode === 'dark' && luminance < 0.2) return mixHex(value, '#ffffff', 72)
  return value
}

function normalizeAccent(value: string, background: string, mode: ThemeVariant) {
  if (contrastRatio(value, background) >= 2.4) return value
  return mixHex(value, mode === 'light' ? '#000000' : '#ffffff', 68)
}

/** Generate the complete Prism semantic palette for one resolved mode. */
export function generatePrismTokens(
  anchors: PrismAnchors,
  mode: ThemeVariant,
  tuning?: PrismTuningPatch,
): PrismTokens {
  const { surfaceMix, raisedMix, minInteractionDelta } = resolveTuning(tuning)
  const fallback = DEFAULT_PRISM_VARIANTS[mode]
  const background = normalizeBackground(validHex(anchors.background, fallback.background), mode)
  const foreground = readableForeground(
    normalizeForeground(validHex(anchors.foreground, fallback.foreground), mode),
    background,
  )
  const accent = normalizeAccent(validHex(anchors.accent, fallback.accent), background, mode)
  const contrast = validContrast(anchors.contrast, mode)
  const primaryForeground = readableForeground(contrastingForeground(accent), accent)
  const surface = (amount: number) => mixOklab(
    background,
    foreground,
    contrastMix(amount, contrast, mode),
  )
  const selection = mixOklab(
    background,
    accent,
    contrastMix(surfaceMix.selection, contrast, mode),
  )
  const raisedSurface = mixOklab(
    background,
    '#ffffff',
    contrastMix(raisedMix[mode], contrast, mode),
  )
  const card = surface(surfaceMix.card)
  const popover = surface(surfaceMix.popover)
  const sidebar = surface(surfaceMix.sidebar)
  const neutralSurfaces = [background, card, popover, sidebar, raisedSurface]
  const interactionFill = (amount: number, minDelta: number) => separatedFill(
    background,
    foreground,
    interactionMix(amount, contrast, mode),
    neutralSurfaces,
    minDelta,
  )
  const border = surface(surfaceMix.border)
  const mutedForeground = readableForeground(mixHex(foreground, background, 34), background)
  const disabledForeground = mixHex(mutedForeground, background, 22)
  const neutralAccent = interactionFill(surfaceMix.accent, minInteractionDelta.accent)
  const hoverSurface = interactionFill(surfaceMix.hover, minInteractionDelta.hover)
  const sidebarAccent = hoverSurface

  return {
    '--background': background,
    '--foreground': foreground,
    '--card': card,
    '--card-foreground': readableForeground(foreground, card),
    '--popover': popover,
    '--popover-foreground': readableForeground(foreground, popover),
    '--secondary': surface(surfaceMix.secondary),
    '--secondary-foreground': readableForeground(foreground, surface(surfaceMix.secondary)),
    '--muted': surface(surfaceMix.muted),
    '--muted-foreground': mutedForeground,
    '--input': surface(surfaceMix.input),
    '--surface-raised': raisedSurface,
    '--surface-raised-foreground': readableForeground(foreground, raisedSurface),
    '--sidebar': sidebar,
    '--sidebar-foreground': readableForeground(foreground, sidebar),
    '--primary': accent,
    '--primary-foreground': primaryForeground,
    '--accent': neutralAccent,
    '--accent-foreground': readableForeground(foreground, neutralAccent),
    '--ring': accent,
    '--selection': selection,
    '--selection-foreground': readableForeground(foreground, selection),
    '--hover': hoverSurface,
    '--hover-foreground': readableForeground(foreground, hoverSurface),
    '--border': border,
    '--input-border': border,
    '--divider': border,
    '--disabled-foreground': disabledForeground,
    '--sidebar-primary': accent,
    '--sidebar-primary-foreground': primaryForeground,
    '--sidebar-accent': sidebarAccent,
    '--sidebar-accent-foreground': readableForeground(foreground, sidebarAccent),
    '--sidebar-border': border,
    '--sidebar-ring': accent,
  }
}
