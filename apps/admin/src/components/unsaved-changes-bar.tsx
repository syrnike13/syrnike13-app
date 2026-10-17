import { useTranslations } from '@syrnike13/ui/i18n'

import { AdminStickyFooter } from '#/components/layout/page'
import { Loader2Icon } from '#/components/icons'
import { Button } from '#/components/ui/button'
import { useAdminDraftController } from '#/components/draft-controller-context'

export function AdminUnsavedChangesBar({
  saveLabel,
}: {
  saveLabel?: string
}) {
  const t = useTranslations('common')
  const controller = useAdminDraftController()

  if (!controller?.isDirty) return null

  return (
    <AdminStickyFooter visible>
      <p className="min-w-0 flex-1 text-[0.8125rem] leading-5 text-muted-foreground">
        {t('unsavedChanges')}
      </p>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={controller.isSaving}
          onClick={() => controller.reset()}
        >
          {t('reset')}
        </Button>
        <Button
          type="button"
          disabled={controller.isSaving}
          onClick={() => void controller.save()}
        >
          {controller.isSaving ? (
            <>
              <Loader2Icon className="size-4 animate-spin" aria-hidden />
              {t('saving')}
            </>
          ) : (
            saveLabel ?? t('save')
          )}
        </Button>
      </div>
    </AdminStickyFooter>
  )
}
