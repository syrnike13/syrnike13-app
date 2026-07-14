import { CheckIcon } from '#/components/icons'
import type { AppearanceSettings } from '@syrnike13/platform'

import type { ThemeDefinition } from '#/features/appearance/theme-registry'
import {
  previewVariantForTheme,
  themeGradientForPreview,
  themePreviewColors,
} from '#/features/appearance/theme-registry'
import { themeGradientCss } from '#/features/appearance/theme-surfaces'
import { cn } from '#/lib/utils'

type ThemePreviewCardProps = {
  theme: ThemeDefinition
  active: boolean
  settings: AppearanceSettings
  prefersDark: boolean
  onSelect: () => void
}

export function ThemePreviewCard({
  theme,
  active,
  settings,
  prefersDark,
  onSelect,
}: ThemePreviewCardProps) {
  const variant = previewVariantForTheme(theme, settings, prefersDark)
  const preview = themePreviewColors(theme, variant)
  const gradient = themeGradientForPreview(
    theme,
    variant,
    active ? settings.gradient : null,
  )

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'group relative flex flex-col gap-2 rounded-lg border p-3 text-left transition-colors',
        active
          ? 'border-primary ring-2 ring-primary/30'
          : 'border-border hover:border-primary/40',
      )}
    >
      <div className="flex gap-1.5">
        <span
          className="h-8 flex-1 rounded-md border border-black/10"
          style={{
            backgroundColor: preview.background,
            backgroundImage:
              theme.kind === 'gradient' ? themeGradientCss(gradient) : undefined,
          }}
          aria-hidden
        />
        <span
          className="h-8 w-8 rounded-md border border-black/10"
          style={{ backgroundColor: preview.primary }}
          aria-hidden
        />
        <span
          className="h-8 w-8 rounded-md border border-black/10"
          style={{ backgroundColor: preview.sidebar }}
          aria-hidden
        />
      </div>
      <div>
        <p className="text-sm font-medium">{theme.name}</p>
        {theme.description ? (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {theme.description}
          </p>
        ) : null}
      </div>
      {active ? (
        <span className="absolute top-2 right-2 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <CheckIcon className="size-3" />
        </span>
      ) : null}
    </button>
  )
}
