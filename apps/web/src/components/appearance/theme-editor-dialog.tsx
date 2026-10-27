import type { AppearanceCustomTheme } from '@syrnike13/platform'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Button } from '@syrnike13/ui/primitives/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@syrnike13/ui/primitives/dialog'

import {
  ThemeEditorFields,
  useThemeDraft,
  type ThemeEditorSubmit,
} from '#/components/appearance/theme-editor-fields'

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

  return (
    <>
      <DialogHeader>
        <DialogTitle>{initial ? t('editTitle') : t('createTitle')}</DialogTitle>
        <DialogDescription>
          {initial ? t('editDescription') : t('createDescription')}
        </DialogDescription>
      </DialogHeader>
      <ThemeEditorFields draft={draft} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button
          type="button"
          disabled={!draft.canSubmit}
          onClick={() =>
            onSubmit({ name: draft.name.trim(), anchors: draft.anchors })
          }
        >
          {initial ? t('save') : t('create')}
        </Button>
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
      <DialogContent className="sm:max-w-lg">
        {open ? (
          <ThemeEditorDialogBody
            initial={initial}
            initialAnchors={initialAnchors}
            onCancel={() => onOpenChange(false)}
            onSubmit={onSubmit}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
