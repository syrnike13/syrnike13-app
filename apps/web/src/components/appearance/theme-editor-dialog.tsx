import type { AppearanceCustomTheme } from '@syrnike13/platform'
import { useTranslations } from '@syrnike13/ui/i18n'
import { ScrollArea } from '@syrnike13/ui/primitives/scroll-area'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@syrnike13/ui/primitives/dialog'

import { ThemeEditorActions } from '#/components/appearance/theme-editor-actions'
import {
  ThemeEditorFields,
  useThemeDraft,
  type ThemeEditorSubmit,
} from '#/components/appearance/theme-editor-fields'
import {
  DraftProvider,
  useDraftRegistration,
} from '#/components/settings/draft-controller-context'
import { PaletteIcon } from '#/components/icons'

function ThemeEditorDialogBody({
  initial,
  initialAnchors,
  onCancel,
  onSubmit,
}: {
  initial: AppearanceCustomTheme | null
  initialAnchors: AppearanceCustomTheme['anchors'] | null
  onCancel: () => void
  onSubmit: (theme: ThemeEditorSubmit) => void
}) {
  const t = useTranslations('settings.appearance.themeEditor')
  const draft = useThemeDraft(initial, initialAnchors)
  useDraftRegistration({
    isDirty: draft.isDirty,
    isSaving: false,
    reset: draft.reset,
    save: async () => {
      if (!draft.canSubmit) return false
      onSubmit({ name: draft.name.trim(), anchors: draft.anchors })
      return true
    },
  })

  return (
    <>
      <DialogHeader className="shrink-0 border-b border-border px-4 py-4 pr-12">
        <DialogTitle className="flex items-center gap-2">
          <PaletteIcon className="size-4 text-muted-foreground" />
          {t('title')}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {initial ? t('editDescription') : t('createDescription')}
        </DialogDescription>
      </DialogHeader>
      <ScrollArea className="h-0 min-h-0 flex-1">
        <div className="p-4">
          <ThemeEditorFields draft={draft} showPreview />
        </div>
      </ScrollArea>
      <DialogFooter className="mx-0 mb-0 shrink-0 flex-col sm:flex-col">
        <ThemeEditorActions
          draft={draft}
          saveLabel={initial ? t('save') : t('create')}
          onSave={() =>
            onSubmit({ name: draft.name.trim(), anchors: draft.anchors })
          }
          onExit={onCancel}
        />
      </DialogFooter>
    </>
  )
}

/** Мобильный вариант редактора: на узком экране боковая панель не помещается. */
export function ThemeEditorDialog({
  open,
  initial,
  initialAnchors,
  onOpenChange,
  onSubmit,
}: {
  open: boolean
  initial: AppearanceCustomTheme | null
  initialAnchors: AppearanceCustomTheme['anchors'] | null
  onOpenChange: (open: boolean) => void
  onSubmit: (theme: ThemeEditorSubmit) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="editor">
        {open ? (
          <DraftProvider>
            <ThemeEditorDialogBody
              initial={initial}
              initialAnchors={initialAnchors}
              onCancel={() => onOpenChange(false)}
              onSubmit={onSubmit}
            />
          </DraftProvider>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
