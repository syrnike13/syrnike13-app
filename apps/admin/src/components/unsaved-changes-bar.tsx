import { AdminStickyFooter } from '#/components/layout/page'
import { Loader2Icon } from '#/components/icons'
import { Button } from '#/components/ui/button'
import { useAdminDraftController } from '#/components/draft-controller-context'

export function AdminUnsavedChangesBar({
  saveLabel = 'Сохранить',
}: {
  saveLabel?: string
}) {
  const controller = useAdminDraftController()

  if (!controller?.isDirty) return null

  return (
    <AdminStickyFooter visible>
      <p className="min-w-0 flex-1 text-[13px] leading-5 text-muted-foreground">
        Есть несохранённые изменения
      </p>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={controller.isSaving}
          onClick={() => controller.reset()}
        >
          Сбросить
        </Button>
        <Button
          type="button"
          disabled={controller.isSaving}
          onClick={() => void controller.save()}
        >
          {controller.isSaving ? (
            <>
              <Loader2Icon className="size-4 animate-spin" aria-hidden />
              Сохранение…
            </>
          ) : (
            saveLabel
          )}
        </Button>
      </div>
    </AdminStickyFooter>
  )
}
