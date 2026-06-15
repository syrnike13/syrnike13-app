import { CheckIcon } from '#/components/icons'
import type { AppearanceSettings } from '@syrnike13/platform'

import type { ThemeDefinition } from '#/features/appearance/theme-registry'
import { previewVariantForTheme, themePreviewColors } from '#/features/appearance/theme-registry'
import { cn } from '#/lib/utils'

type ThemePreviewCardProps = {
  theme: ThemeDefinition
  active: boolean
  settings: AppearanceSettings
  prefersDark: boolean
  onSelect: () => void
  onPlayNote?: () => void
}

export function ThemePreviewCard({
  theme,
  active,
  settings,
  prefersDark,
  onSelect,
  onPlayNote,
}: ThemePreviewCardProps) {
  const variant = previewVariantForTheme(theme, settings, prefersDark)
  const preview = themePreviewColors(theme, variant)

  return (
    <div
      className={cn(
        'group relative flex flex-col gap-2 rounded-lg border p-3 text-left transition-colors',
        active
          ? 'border-primary ring-2 ring-primary/30'
          : 'border-border hover:border-primary/40',
      )}
    >
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={onSelect}
          className="h-8 min-w-0 flex-1 rounded-md border border-black/10 text-left"
          style={{ backgroundColor: preview.background }}
          aria-label={`Выбрать палитру ${theme.name}`}
        />
        <button
          type="button"
          onClick={onSelect}
          className="h-8 w-8 rounded-md border border-black/10"
          style={{ backgroundColor: preview.primary }}
          aria-label={`Выбрать палитру ${theme.name}`}
        />
        <button
          type="button"
          onClick={onPlayNote ?? onSelect}
          className={cn(
            'relative flex h-8 w-8 items-center justify-center rounded-md border border-black/10',
            'transition-[box-shadow,transform] hover:ring-2 hover:ring-primary/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            onPlayNote && 'active:scale-95',
          )}
          style={{ backgroundColor: preview.sidebar }}
          aria-label={`Сыграть ноту палитры ${theme.name}`}
        >
          <span className="sr-only">Сыграть ноту</span>
        </button>
      </div>
      <button type="button" onClick={onSelect} className="text-left">
        <p className="text-sm font-medium">{theme.name}</p>
        {theme.description ? (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {theme.description}
          </p>
        ) : null}
      </button>
      {active ? (
        <span className="pointer-events-none absolute top-2 right-2 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <CheckIcon className="size-3" />
        </span>
      ) : null}
    </div>
  )
}
