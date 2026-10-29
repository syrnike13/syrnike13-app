import type { AppearanceCustomTheme } from '@syrnike13/platform'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Button } from '@syrnike13/ui/primitives/button'
import { ScrollArea } from '@syrnike13/ui/primitives/scroll-area'
import { applyThemeToDocument } from '@syrnike13/ui/tokens'
import { useCallback, useEffect } from 'react'

import {
  ThemeEditorFields,
  useThemeDraft,
} from '#/components/appearance/theme-editor-fields'
import { XIcon } from '#/components/icons'
import { appearanceSettingsStore } from '#/features/appearance/appearance-settings-store'
import {
  applyAppearanceTheme,
  createCustomThemeId,
  resolveThemeForVariant,
} from '#/features/appearance/appearance-themes'
import { useAppearance } from '#/features/appearance/appearance-context'
import {
  useThemeStudio,
  type ThemeStudioTarget,
} from '#/features/appearance/theme-studio-context'
import { useSettingsModal } from '#/features/settings/settings-modal-context'
import { cn } from '#/lib/utils'

function ThemeStudioContent({
  target,
  onClose,
}: {
  target: ThemeStudioTarget
  onClose: () => void
}) {
  const t = useTranslations('settings.appearance.themeEditor')
  const tPreview = useTranslations('settings.appearance.preview')
  const { settings, createCustomTheme, updateCustomTheme } = useAppearance()
  const { openSettings } = useSettingsModal()
  const initial =
    target.mode === 'edit'
      ? (settings.customThemes.find((theme) => theme.id === target.themeId) ??
        null)
      : null
  const draft = useThemeDraft(
    initial,
    target.mode === 'create' ? target.anchors : null,
  )

  // Черновик сразу применяется к живому интерфейсу.
  useEffect(() => {
    applyThemeToDocument(settings, undefined, undefined, draft.anchors, (variant) =>
      resolveThemeForVariant(settings, variant),
    )
  }, [draft.anchors, settings])

  // Выход из редактора возвращает сохранённую тему.
  useEffect(() => {
    return () => {
      applyAppearanceTheme(appearanceSettingsStore.getState())
    }
  }, [])

  // Любой выход из предпросмотра возвращает человека в настройки.
  const exitToSettings = useCallback(() => {
    onClose()
    openSettings('appearance')
  }, [onClose, openSettings])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      exitToSettings()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [exitToSettings])

  const submit = () => {
    const name = draft.name.trim()
    if (!name) return
    if (target.mode === 'edit') {
      const themeId = target.themeId
      updateCustomTheme(themeId, (theme) => ({
        ...theme,
        name,
        anchors: draft.anchors,
      }))
    } else {
      const theme: AppearanceCustomTheme = {
        id: createCustomThemeId(),
        name,
        anchors: draft.anchors,
      }
      createCustomTheme(theme)
    }
    exitToSettings()
  }

  return (
    <aside className="theme-surface-content flex w-80 shrink-0 flex-col border-l border-border bg-card text-card-foreground xl:w-96 2xl:w-104">
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <span className="mb-1 inline-flex items-center rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
            {tPreview('badge')}
          </span>
          <h2 className="truncate text-sm font-semibold">
            {initial ? t('editTitle') : t('createTitle')}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {initial ? t('editDescription') : t('createDescription')}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={tPreview('exit')}
          onClick={exitToSettings}
        >
          <XIcon />
        </Button>
      </header>
      <ScrollArea className="h-0 min-h-0 flex-1">
        <div className="@container p-4">
          <ThemeEditorFields draft={draft} />
        </div>
      </ScrollArea>
      {/* В dev справа снизу висит кнопка DEV и перекрывает кнопки панели. */}
      <footer
        className={cn(
          'flex shrink-0 justify-end gap-2 border-t border-border px-4 py-3',
          import.meta.env.DEV && 'pb-14',
        )}
      >
        <Button type="button" variant="outline" onClick={exitToSettings}>
          {t('cancel')}
        </Button>
        <Button type="button" disabled={!draft.canSubmit} onClick={submit}>
          {initial ? t('save') : t('create')}
        </Button>
      </footer>
    </aside>
  )
}

/**
 * Правая панель редактора тем в оболочке приложения: сдвигает контент,
 * поэтому изменения видно на настоящем интерфейсе.
 */
export function ThemeStudioPanel() {
  const { target, close } = useThemeStudio()
  if (!target) return null
  return (
    <ThemeStudioContent key={target.nonce} target={target} onClose={close} />
  )
}
