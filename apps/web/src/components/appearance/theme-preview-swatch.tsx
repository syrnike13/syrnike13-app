import type { AppearanceSettings } from '@syrnike13/platform'

import { CheckIcon } from '#/components/icons'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import type { ThemeDefinition } from '#/features/appearance/theme-registry'
import {
  previewVariantForTheme,
  themeGradientForPreview,
  themePreviewColors,
} from '#/features/appearance/theme-registry'
import { themeGradientCss } from '#/features/appearance/theme-surfaces'
import { cn } from '#/lib/utils'

type ThemePreviewSwatchProps = {
  theme: ThemeDefinition
  active: boolean
  settings: AppearanceSettings
  prefersDark: boolean
  onSelect: () => void
}

export function ThemePreviewSwatch({
  theme,
  active,
  settings,
  prefersDark,
  onSelect,
}: ThemePreviewSwatchProps) {
  const variant = previewVariantForTheme(theme, settings, prefersDark)
  const preview = themePreviewColors(theme, variant)
  const gradient = themeGradientForPreview(
    theme,
    variant,
    active ? settings.gradient : null,
  )
  const backgroundImage =
    theme.kind === 'gradient'
      ? themeGradientCss(gradient)
      : `linear-gradient(135deg, ${preview.background} 0 58%, ${preview.sidebar} 58% 78%, ${preview.primary} 78% 100%)`

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`Тема «${theme.name}»`}
          aria-pressed={active}
          onClick={onSelect}
          className={cn(
            'group relative h-11 w-16 shrink-0 overflow-hidden rounded-lg border-2 transition-[border-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            active
              ? 'border-primary shadow-sm ring-2 ring-primary/25'
              : 'border-border/60 hover:border-foreground/40',
          )}
        >
          <span
            className="absolute inset-0"
            style={{ backgroundImage }}
            aria-hidden
          />
          <span
            className="absolute inset-0 bg-foreground/0 transition-colors group-hover:bg-foreground/5"
            aria-hidden
          />
          {active ? (
            <span className="absolute right-1.5 bottom-1.5 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
              <CheckIcon className="size-2.5" />
            </span>
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8} className="max-w-56">
        <p className="font-medium">{theme.name}</p>
        {theme.description ? (
          <p className="mt-0.5 text-muted-foreground">{theme.description}</p>
        ) : null}
      </TooltipContent>
    </Tooltip>
  )
}
