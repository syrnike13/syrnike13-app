// Vendored from @empatraai/prism (Empatra ADR-0016); keep in sync with the package.
export {
  DEFAULT_PRISM_TUNING,
  generatePrismTokens,
} from './prism-generator.js'
export type {
  PrismInteractionDeltaKey,
  PrismSurfaceMixKey,
  PrismTuning,
  PrismTuningPatch,
} from './prism-generator.js'
export { DEFAULT_PRISM_VARIANTS, createDefaultPrismVariants } from './prism-defaults.js'
export { DEFAULT_CONTRAST, MIN_CONTRAST, MAX_CONTRAST } from './types.js'
export type { PrismAnchors, PrismTokens, PrismVariants, PrismTheme, ThemeMode, ThemeVariant } from './types.js'
export { applyPrismTheme, getPrismAttributes, getPrismCss, resolvePrismMode } from './theme.js'
