import { useTranslations } from '@syrnike13/ui/i18n'
import { Button } from '@syrnike13/ui/primitives/button'
import type { ThemeDefinition, ThemeVariant } from '@syrnike13/ui/tokens'

import { CopyIcon, PencilIcon, Trash2Icon } from '#/components/icons'
import { ThemeOrbSlots } from '#/components/appearance/theme-orbs'

export function ThemeCard({
  theme,
  name,
  description,
  selected,
  onSelectActive,
  onSelectVariant,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  theme: ThemeDefinition
  name: string
  description?: string
  /** Для какого варианта эта тема сейчас выбрана. */
  selected: Record<ThemeVariant, boolean>
  /** Клик по карточке ставит тему в активный сейчас вариант. */
  onSelectActive: () => void
  onSelectVariant: (variant: ThemeVariant) => void
  onEdit?: () => void
  onDuplicate?: () => void
  onDelete?: () => void
}) {
  const t = useTranslations('settings.appearance')
  const tThemes = useTranslations('themes')
  const editable = Boolean(onEdit || onDuplicate || onDelete)

  return (
    <div className="group relative flex flex-col justify-between gap-4 rounded-lg border border-border bg-card p-4 transition-colors hover:border-foreground/30">
      {/* eslint-disable-next-line design/no-lookalike -- карточка выбирает тему целиком, сферы и действия лежат поверх */}
      <button
        type="button"
        aria-label={tThemes('ariaLabel', { name })}
        className="absolute inset-0 z-10 rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
        onClick={onSelectActive}
      />
      <div className="relative z-20 flex items-center justify-center gap-4">
        <ThemeOrbSlots
          theme={theme}
          name={name}
          selected={selected}
          onSelect={onSelectVariant}
        />
      </div>
      <div className="pointer-events-none relative z-20 flex items-end justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm text-foreground">{name}</p>
          {description ? (
            <p className="truncate text-xs text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {editable ? (
          <div className="pointer-events-auto flex shrink-0 items-center gap-0.5">
            {onDuplicate ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('themesSection.duplicate', { name })}
                onClick={onDuplicate}
              >
                <CopyIcon />
              </Button>
            ) : null}
            {onEdit ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('themesSection.edit', { name })}
                onClick={onEdit}
              >
                <PencilIcon />
              </Button>
            ) : null}
            {onDelete ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('themesSection.delete', { name })}
                onClick={onDelete}
              >
                <Trash2Icon />
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
