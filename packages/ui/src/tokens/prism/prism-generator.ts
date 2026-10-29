import {
  contrastingForeground,
  mixHex,
  mixOklab,
  normalizeHex,
  oklabLightness,
  relativeLuminance,
} from './color-utils.js'
import {
  DEFAULT_CONTRAST,
  MAX_CONTRAST,
  MAX_GRADIENT_COLORS,
  MAX_GRADIENT_MIX,
  MIN_CONTRAST,
  MIN_GRADIENT_COLORS,
  MIN_GRADIENT_MIX,
  type PrismGradient,
  type ThemeVariant,
} from './types.js'
import { DEFAULT_PRISM_VARIANTS } from './prism-defaults.js'

import type { PrismAnchors, PrismTokens } from './types.js'

/**
 * OKLab mix percentages toward the foreground. The same amount is the same visible step in
 * light and dark mode, so one table serves both. Layout surfaces and borders step from the
 * background; fills and interaction states step from the raised surface they sit on, so in dark
 * mode, where raised surfaces and fills both lighten, a fill never merges into its card.
 */
const SURFACE_MIX = {
  card: 2,
  popover: 1,
  secondary: 7,
  muted: 9,
  input: 8,
  sidebar: 4,
  border: 11,
  accent: 10,
  hover: 16,
  selection: 18,
} as const

const RAISED_MIX = { light: 14, dark: 5 } as const

/**
 * Minimum OKLab lightness gap between an interaction fill and every neutral surface it can sit
 * on (background, card, popover, sidebar, raised), so hover never vanishes on one of them.
 */
const MIN_INTERACTION_DELTA = { accent: 0.045, hover: 0.07 } as const

/**
 * Opacity of each base layer over the gradient, as a share of the mix-scaled coverage: the
 * sidebar lets the most gradient through, reading surfaces the least.
 */
const GRADIENT_LAYER = { sidebar: 0.4, background: 0.8, raised: 0.9 } as const
const DEFAULT_GRADIENT = { angle: 180, mix: 60 } as const

/**
 * Tokens that exist only under a gradient; clients remove them when the gradient goes away.
 * Layer tokens are the translucent window planes the gradient shows through; without a gradient
 * the Tailwind `layer-*` roles fall back to the plain sidebar, background and raised surfaces.
 */
export const PRISM_GRADIENT_TOKENS = [
  '--app-gradient',
  '--layer-frame',
  '--layer-sidebar',
  '--layer-panel',
  '--layer-raised',
] as const

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
  base: string,
  foreground: string,
  amount: number,
  surfaces: readonly string[],
  minDelta: number,
) {
  const gap = (fill: string) => Math.min(
    ...surfaces.map(surface => Math.abs(oklabLightness(fill) - oklabLightness(surface))),
  )
  let mix = amount
  let fill = mixOklab(base, foreground, mix)
  while (gap(fill) < minDelta && mix < 60) {
    mix += 1
    fill = mixOklab(base, foreground, mix)
  }
  return fill
}

function normalizeGradient(gradient: PrismGradient | undefined) {
  if (!gradient) return null
  const colors = gradient.colors
    .map(normalizeHex)
    .filter((color): color is string => color !== null)
    .slice(0, MAX_GRADIENT_COLORS)
  if (colors.length < MIN_GRADIENT_COLORS) return null
  const angle = Number.isFinite(gradient.angle)
    ? ((Math.round(gradient.angle) % 360) + 360) % 360
    : DEFAULT_GRADIENT.angle
  const mix = Number.isFinite(gradient.mix)
    ? Math.max(MIN_GRADIENT_MIX, Math.min(MAX_GRADIENT_MIX, gradient.mix))
    : DEFAULT_GRADIENT.mix
  return { colors, angle, mix }
}

/** Raise a layer's opacity until its text stays readable over every gradient stop. */
function readableLayerAlpha(layer: string, stops: string[], texts: string[], start: number) {
  const readable = (alpha: number) => stops.every((stop) => {
    const composite = mixHex(stop, layer, alpha)
    return texts.every(text => contrastRatio(text, composite) >= 4.5)
  })
  let alpha = Math.min(100, Math.round(start))
  while (alpha < 100 && !readable(alpha)) alpha += 1
  return alpha
}

/** The average color of the gradient, the backdrop a static surface stands in for. */
function gradientMean(colors: string[]) {
  return colors.reduce((mean, color, index) => mixOklab(mean, color, 100 / (index + 1)))
}

/** A translucent wash of `hex`, so a fill tints whatever layer and gradient sit below it. */
function withAlpha(hex: string, percent: number) {
  // Round up so an 8-bit alpha never drops below the opacity readability was checked at.
  const alpha = Math.ceil(Math.max(0, Math.min(100, percent)) / 100 * 255)
  return `${hex}${alpha.toString(16).padStart(2, '0')}`
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
export function generatePrismTokens(anchors: PrismAnchors, mode: ThemeVariant): PrismTokens {
  const fallback = DEFAULT_PRISM_VARIANTS[mode]
  const background = normalizeBackground(validHex(anchors.background, fallback.background), mode)
  const foreground = readableForeground(
    normalizeForeground(validHex(anchors.foreground, fallback.foreground), mode),
    background,
  )
  const accent = normalizeAccent(validHex(anchors.accent, fallback.accent), background, mode)
  const contrast = validContrast(anchors.contrast, mode)
  const primaryForeground = readableForeground(contrastingForeground(accent), accent)
  const surface = (amount: number, base = background) => mixOklab(
    base,
    foreground,
    contrastMix(amount, contrast, mode),
  )
  const selection = mixOklab(
    background,
    accent,
    contrastMix(SURFACE_MIX.selection, contrast, mode),
  )
  const raisedSurface = mixOklab(
    background,
    '#ffffff',
    contrastMix(RAISED_MIX[mode], contrast, mode),
  )
  const card = surface(SURFACE_MIX.card)
  const popover = surface(SURFACE_MIX.popover)
  const sidebar = surface(SURFACE_MIX.sidebar)
  const neutralSurfaces = [background, card, popover, sidebar, raisedSurface]
  const fill = (amount: number) => surface(amount, raisedSurface)
  const interactionFill = (amount: number, minDelta: number) => separatedFill(
    raisedSurface,
    foreground,
    interactionMix(amount, contrast, mode),
    neutralSurfaces,
    minDelta,
  )
  const border = surface(SURFACE_MIX.border)
  const secondary = fill(SURFACE_MIX.secondary)
  const mutedForeground = readableForeground(mixHex(foreground, background, 34), background)
  const disabledForeground = mixHex(mutedForeground, background, 22)
  const neutralAccent = interactionFill(SURFACE_MIX.accent, MIN_INTERACTION_DELTA.accent)
  const hoverSurface = interactionFill(SURFACE_MIX.hover, MIN_INTERACTION_DELTA.hover)
  const sidebarAccent = hoverSurface

  const tokens: PrismTokens = {
    '--background': background,
    '--foreground': foreground,
    '--card': card,
    '--card-foreground': readableForeground(foreground, card),
    '--popover': popover,
    '--popover-foreground': readableForeground(foreground, popover),
    '--secondary': secondary,
    '--secondary-foreground': readableForeground(foreground, secondary),
    '--muted': fill(SURFACE_MIX.muted),
    '--muted-foreground': mutedForeground,
    '--input': fill(SURFACE_MIX.input),
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

  const gradient = normalizeGradient(anchors.gradient)
  if (!gradient) return tokens

  // Window layers become translucent planes over the gradient. Everything else that paints a
  // surface (dialogs, menus, popovers, sticky bars over scrolling content) stays opaque: it gets
  // the color its layer has over the gradient's average, so it matches the theme without
  // letting content underneath show through.
  const coverage = 45 + 0.8 * gradient.mix
  const layerAlpha = (layer: string, share: number, texts: string[]) =>
    readableLayerAlpha(layer, gradient.colors, texts, share * coverage)
  const frameAlpha = layerAlpha(
    sidebar,
    GRADIENT_LAYER.sidebar,
    [tokens['--sidebar-foreground'], mutedForeground],
  )
  const panelAlpha = layerAlpha(background, GRADIENT_LAYER.background, [foreground, mutedForeground])
  const raisedAlpha = layerAlpha(
    raisedSurface,
    GRADIENT_LAYER.raised,
    [tokens['--surface-raised-foreground'], mutedForeground],
  )
  const mean = gradientMean(gradient.colors)
  const solid = (surface: string, alpha: number) => mixHex(mean, surface, alpha)
  const staticBackground = solid(background, panelAlpha)
  const staticCard = solid(card, raisedAlpha)
  const staticPopover = solid(popover, raisedAlpha)
  const staticRaised = solid(raisedSurface, raisedAlpha)
  const staticSidebar = solid(sidebar, frameAlpha)
  const staticInput = solid(tokens['--input'], raisedAlpha)
  const wash = (amount: number) => withAlpha(foreground, contrastMix(amount, contrast, mode))
  const interactionWash = (amount: number) =>
    withAlpha(foreground, interactionMix(amount, contrast, mode))
  const borderWash = wash(SURFACE_MIX.border)

  return {
    ...tokens,
    '--background': staticBackground,
    '--card': staticCard,
    '--card-foreground': readableForeground(foreground, staticCard),
    '--popover': staticPopover,
    '--popover-foreground': readableForeground(foreground, staticPopover),
    '--surface-raised': staticRaised,
    '--surface-raised-foreground': readableForeground(foreground, staticRaised),
    '--sidebar': staticSidebar,
    '--sidebar-foreground': readableForeground(foreground, staticSidebar),
    '--input': staticInput,
    '--app-gradient': `linear-gradient(${gradient.angle}deg, ${gradient.colors.join(', ')})`,
    '--layer-frame': withAlpha(sidebar, frameAlpha),
    '--layer-sidebar': withAlpha(sidebar, 0),
    '--layer-panel': withAlpha(background, panelAlpha),
    '--layer-raised': withAlpha(raisedSurface, raisedAlpha),
    '--secondary': wash(SURFACE_MIX.secondary),
    '--muted': wash(SURFACE_MIX.muted),
    '--accent': interactionWash(SURFACE_MIX.accent),
    '--hover': interactionWash(SURFACE_MIX.hover),
    '--sidebar-accent': interactionWash(SURFACE_MIX.hover),
    '--border': borderWash,
    '--input-border': borderWash,
    '--divider': borderWash,
    '--sidebar-border': borderWash,
  }
}
