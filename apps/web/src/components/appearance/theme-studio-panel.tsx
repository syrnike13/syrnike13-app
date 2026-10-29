import type { AppearanceCustomTheme } from '@syrnike13/platform'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Button } from '@syrnike13/ui/primitives/button'
import { ScrollArea } from '@syrnike13/ui/primitives/scroll-area'
import { applyThemeToDocument } from '@syrnike13/ui/tokens'
import { useCallback, useEffect } from 'react'

import { ThemeEditorActions } from '#/components/appearance/theme-editor-actions'
import {
  ThemeEditorFields,
  useThemeDraft,
} from '#/components/appearance/theme-editor-fields'
import { PaletteIcon, XIcon } from '#/components/icons'
import { appearanceSettingsStore } from '#/features/appearance/appearance-settings-store'
import {
  applyAppearanceTheme,
  createCustomThemeId,
} from '#/features/appearance/appearance-themes'
import { useAppearance } from '#/features/appearance/appearance-context'
import {
  useThemeStudio,
  type ThemeStudioTarget,
} from '#/features/appearance/theme-studio-context'
import { useSettingsModal } from '#/features/settings/settings-modal-context'
import { cn } from '#/lib/utils'
import {
  DraftProvider,
  useDraftRegistration,
} from '#/components/settings/draft-controller-context'

function ThemeStudioContent({
  target,
  onClose,
}: {
  target: ThemeStudioTarget
  onClose: () => void
}) {
  const t = useTranslations('settings.appearance.themeEditor')
  const tPreview = useTranslations('settings.appearance.preview')
  const { settings, resolvedVariant, createCustomTheme, updateCustomTheme } =
    useAppearance()
  const { openSettings } = useSettingsModal()
  const initial =
    target.mode === 'edit'
      ? (settings.customThemes.find((theme) => theme.id === target.themeId) ??
        null)
      : null
  const draft = useThemeDraft(
    initial,
    target.mode === 'create' ? target.anchors : null,
    resolvedVariant,
  )

  // Черновик сразу применяется к живому интерфейсу.
  useEffect(() => {
    applyThemeToDocument(
      { ...settings, gradient: null, colorMode: draft.variant },
      undefined,
      draft.previewTheme,
    )
  }, [draft.anchors, draft.variant, settings])

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

  useDraftRegistration({
    isDirty: draft.isDirty,
    isSaving: false,
    save: async () => {
      if (!draft.canSubmit) return false
      submit()
      return true
    },
    reset: draft.reset,
  })

  return (
    <aside
      aria-label={t('title')}
      className="theme-surface-content flex w-80 shrink-0 flex-col border-l border-border bg-card text-card-foreground"
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <PaletteIcon className="size-4 shrink-0 text-muted-foreground" />
          {t('title')}
        </h2>
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
      <footer
        className={cn(
          'flex shrink-0 flex-col gap-2 border-t border-border px-4 py-3',
          import.meta.env.DEV && 'pb-14',
        )}
      >
        <ThemeEditorActions
          draft={draft}
          saveLabel={initial ? t('save') : t('create')}
          onSave={submit}
          onExit={exitToSettings}
        />
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
    <DraftProvider>
      <ThemeStudioContent key={target.nonce} target={target} onClose={close} />
    </DraftProvider>
  )
}
