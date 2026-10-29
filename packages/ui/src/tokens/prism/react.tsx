import { useEffect, useMemo } from 'react'
import type { ComponentProps, CSSProperties, HTMLAttributes } from 'react'
import { generatePrismTokens } from './prism-generator.js'
import { applyPrismTheme, getPrismAttributes, getPrismCss } from './theme.js'
import type { PrismAnchors, PrismTheme, PrismTokens, PrismVariants, ThemeVariant } from './types.js'

export type PrismCSSProperties = CSSProperties & PrismTokens

export function usePrismTokens(anchors: PrismAnchors, mode: ThemeVariant) {
  const { accent, background, foreground, contrast } = anchors
  return useMemo(() => generatePrismTokens({ accent, background, foreground, contrast }, mode),
    [accent, background, foreground, contrast, mode])
}

export type PrismScopeProps = HTMLAttributes<HTMLElement> & {
  anchors: PrismAnchors
  mode: ThemeVariant
  as?: 'div' | 'main' | 'section' | 'article'
}

/** A local theme never writes document settings or storage. */
export function PrismScope({ anchors, mode, as: Tag = 'div', style, className, ...props }: PrismScopeProps) {
  const tokens = usePrismTokens(anchors, mode)
  return <Tag {...props} {...getPrismAttributes(mode)}
    className={mode === 'dark' ? ['dark', className].filter(Boolean).join(' ') : className}
    style={{ ...style, ...tokens, colorScheme: mode } as PrismCSSProperties} />
}

export type PrismStyleProps = Omit<ComponentProps<'style'>, 'children'> & {
  variants: PrismVariants
  mode: ThemeVariant
}

/** Render in the document head for fixed SSR themes, before page content. */
export function PrismStyle({ variants, mode, id = 'empatra-prism', ...props }: PrismStyleProps) {
  return <style {...props} id={id}>{getPrismCss(variants, mode)}</style>
}

/** Controlled document updates; the app owns persistence and initial bootstrapping. */
export function usePrismDocumentTheme(theme: PrismTheme, mode: ThemeVariant) {
  const { light, dark } = theme
  useEffect(() => {
    applyPrismTheme(document.documentElement, theme, mode)
  }, [theme.mode, mode, light.accent, light.background, light.foreground, light.contrast,
    dark.accent, dark.background, dark.foreground, dark.contrast])
}
