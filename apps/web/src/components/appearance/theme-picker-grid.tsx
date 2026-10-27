import { useTranslations } from '@syrnike13/ui/i18n'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@syrnike13/ui/primitives/alert-dialog'
import { useState } from 'react'

import { ThemeCard } from '#/components/appearance/theme-card'
import { useAppearance } from '#/features/appearance/appearance-context'

export function ThemePickerGrid({
  onEditRequest,
}: {
  onEditRequest?: (themeId: string) => void
}) {
  const t = useTranslations('settings.appearance')
  const tThemes = useTranslations('themes')
  const {
    settings,
    resolvedVariant,
    themes,
    customThemes,
    setThemeId,
    setColorMode,
    duplicateCustomTheme,
    deleteCustomTheme,
  } = useAppearance()
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)

  const customById = new Map(customThemes.map((theme) => [theme.id, theme]))
  const pendingDelete = pendingDeleteId
    ? customThemes.find((theme) => theme.id === pendingDeleteId)
    : undefined

  return (
    <>
      <div className="grid grid-cols-1 gap-3 pt-2 sm:grid-cols-2 xl:grid-cols-3">
        {themes.map((theme) => {
          const custom = customById.get(theme.id)
          return (
            <ThemeCard
              key={theme.id}
              theme={theme}
              name={custom?.name ?? tThemes(`${theme.id}.name`)}
              description={custom ? undefined : tThemes(`${theme.id}.description`)}
              selected={{
                light: settings.themeIds.light === theme.id,
                dark: settings.themeIds.dark === theme.id,
              }}
              onSelectActive={() => setThemeId(theme.id, resolvedVariant)}
              onSelectVariant={(variant) => {
                setThemeId(theme.id, variant)
                setColorMode(variant)
              }}
              onEdit={
                custom && onEditRequest
                  ? () => onEditRequest(theme.id)
                  : undefined
              }
              onDuplicate={
                custom
                  ? () =>
                      duplicateCustomTheme(
                        theme.id,
                        t('themesSection.copySuffix'),
                      )
                  : undefined
              }
              onDelete={custom ? () => setPendingDeleteId(theme.id) : undefined}
            />
          )
        })}
      </div>

      <AlertDialog
        open={pendingDelete !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteId(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('themesSection.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('themesSection.deleteDescription', {
                name: pendingDelete?.name ?? '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('themesSection.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (pendingDeleteId) deleteCustomTheme(pendingDeleteId)
                setPendingDeleteId(null)
              }}
            >
              {t('themesSection.deleteConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
