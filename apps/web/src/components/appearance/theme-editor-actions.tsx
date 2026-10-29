import { useTranslations } from '@syrnike13/ui/i18n'
import { Button } from '@syrnike13/ui/primitives/button'

import type { ThemeEditorDraft } from '#/components/appearance/theme-editor-fields'
import { ArrowLeftIcon, DiceIcon } from '#/components/icons'

/**
 * Draft actions shared by the desktop sidebar and the mobile dialog: surprise,
 * reset, a plain save button that is active only while there is something to
 * save, and the way back to settings.
 */
export function ThemeEditorActions({
  draft,
  saveLabel,
  onSave,
  onExit,
}: {
  draft: ThemeEditorDraft
  saveLabel: string
  onSave: () => void
  onExit: () => void
}) {
  const t = useTranslations('settings.appearance.themeEditor')
  const tUnsaved = useTranslations('settings.unsaved')
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        className="w-full"
        onClick={draft.randomize}
      >
        <DiceIcon />
        {t('randomize')}
      </Button>
      <Button
        type="button"
        variant="secondary"
        className="w-full"
        disabled={!draft.isDirty}
        onClick={() => draft.reset()}
      >
        {tUnsaved('reset')}
      </Button>
      <Button
        type="button"
        className="w-full"
        disabled={!draft.isDirty || !draft.canSubmit}
        onClick={onSave}
      >
        {saveLabel}
      </Button>
      <Button
        type="button"
        variant="ghost"
        className="w-full text-muted-foreground"
        onClick={onExit}
      >
        <ArrowLeftIcon />
        {t('backToSettings')}
      </Button>
    </>
  )
}
