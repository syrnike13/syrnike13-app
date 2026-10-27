import type { ThemeDefinition, ThemeVariant } from '@syrnike13/ui/tokens'
import { themePreviewColors } from '@syrnike13/ui/tokens'

import type { CSSVars } from '#/lib/css-vars'
import { cn } from '#/lib/utils'

type PreviewPalette = {
  background: string
  sidebar: string
  card: string
  line: string
  accent: string
}

function paletteFor(
  theme: ThemeDefinition,
  variant: ThemeVariant,
): PreviewPalette {
  const colors = themePreviewColors(theme, variant)
  return {
    background: colors.background,
    sidebar: colors.sidebar,
    card: colors.card,
    line: colors.muted,
    accent: colors.primary,
  }
}

function Line({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('block h-1 rounded-full bg-(--mini-line)', className)}
    />
  )
}

/**
 * Миниатюра приложения для карточек схемы: сайдбар, лента и панель участников.
 * Цвета берутся у конкретного варианта темы, а не у текущего документа.
 */
function PreviewFrame({ palette }: { palette: PreviewPalette }) {
  return (
    <div
      aria-hidden
      className="flex h-full w-full overflow-hidden rounded-md bg-(--mini-bg)"
      style={
        {
          '--mini-bg': palette.background,
          '--mini-sidebar': palette.sidebar,
          '--mini-card': palette.card,
          '--mini-line': palette.line,
          '--mini-accent': palette.accent,
        } as CSSVars
      }
    >
      <div className="flex w-1/5 flex-col gap-1.5 bg-(--mini-sidebar) p-2">
        <span className="block h-1.5 w-3/4 rounded-full bg-(--mini-accent)" />
        <Line className="w-full" />
        <Line className="w-5/6" />
        <Line className="w-2/3" />
      </div>
      <div className="flex flex-1 flex-col justify-between gap-2 p-2">
        <div className="flex flex-col gap-1.5">
          <span className="block h-1.5 w-1/2 rounded-full bg-(--mini-accent)" />
          <Line className="w-4/5" />
          <Line className="w-3/5" />
        </div>
        <div className="flex items-center gap-1.5 rounded-full bg-(--mini-card) px-2 py-1.5">
          <Line className="w-2/3" />
          <span className="ml-auto block size-1.5 shrink-0 rounded-full bg-(--mini-accent)" />
        </div>
      </div>
      <div className="flex w-1/4 flex-col gap-1.5 bg-(--mini-sidebar) p-2">
        <div className="flex items-center gap-1">
          <span className="block size-1.5 rounded-full bg-(--mini-accent)" />
          <Line className="w-2/3" />
        </div>
        <Line className="w-3/4" />
        <div className="flex items-center gap-1">
          <span className="block size-1.5 rounded-full bg-(--mini-line)" />
          <Line className="w-1/2" />
        </div>
      </div>
    </div>
  )
}

export function ThemePreviewMini({
  theme,
  variant,
}: {
  theme: ThemeDefinition
  /** `split` показывает светлую половину поверх тёмной — схема «системная». */
  variant: ThemeVariant | 'split'
}) {
  if (variant !== 'split') {
    return (
      <div className="h-24 w-full">
        <PreviewFrame palette={paletteFor(theme, variant)} />
      </div>
    )
  }

  return <ThemePreviewSplit lightTheme={theme} darkTheme={theme} />
}

/** Схема «системная»: светлая тема слева, тёмная справа, со срезом. */
export function ThemePreviewSplit({
  lightTheme,
  darkTheme,
}: {
  lightTheme: ThemeDefinition
  darkTheme: ThemeDefinition
}) {
  return (
    <div className="relative h-24 w-full overflow-hidden rounded-md">
      <PreviewFrame palette={paletteFor(darkTheme, 'dark')} />
      <div aria-hidden className="theme-split-preview absolute inset-0">
        <PreviewFrame palette={paletteFor(lightTheme, 'light')} />
      </div>
    </div>
  )
}
