import { useState } from 'react'
import type { Category } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import {
  DraftProvider,
  useDraftRegistration,
} from '#/components/settings/draft-controller-context'
import { UnsavedChangesBar } from '#/components/settings/unsaved-changes-bar'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { useAuth } from '#/features/auth/auth-context'
import { editServer } from '#/features/api/servers-api'
import { syncStore } from '#/features/sync/sync-store'

type CategorySettingsDialogProps = {
  serverId: string
  category: Category
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CategorySettingsDialog({
  ...props
}: CategorySettingsDialogProps) {
  return (
    <DraftProvider>
      <CategorySettingsDialogContent {...props} />
    </DraftProvider>
  )
}

function CategorySettingsDialogContent({
  serverId,
  category,
  open,
  onOpenChange,
}: CategorySettingsDialogProps) {
  const auth = useAuth()
  const [title, setTitle] = useState(category.title)
  const [savedTitle, setSavedTitle] = useState(category.title)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmingDeletion, setConfirmingDeletion] = useState(false)

  const isDirty = title.trim() !== savedTitle.trim()

  async function save(): Promise<boolean> {
    const token = auth.session?.token
    const trimmed = title.trim()
    if (!token || !trimmed) return false

    const server = syncStore.getState().servers[serverId]
    if (!server) return false

    setSaving(true)
    try {
      const categories = (server.categories ?? []).map((item) =>
        item.id === category.id ? { ...item, title: trimmed } : item,
      )
      const updated = await editServer(token, serverId, { categories })
      syncStore.upsertServer(updated)
      setTitle(trimmed)
      setSavedTitle(trimmed)
      toast.success('Категория обновлена')
      return true
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось сохранить',
      )
      return false
    } finally {
      setSaving(false)
    }
  }

  function resetDraft() {
    setTitle(savedTitle)
    return true
  }

  useDraftRegistration(
    open && !confirmingDeletion
      ? {
          isDirty,
          isSaving: saving,
          save,
          reset: resetDraft,
        }
      : null,
  )

  async function removeCategory() {
    const token = auth.session?.token
    if (!token) return

    const server = syncStore.getState().servers[serverId]
    if (!server) return

    setDeleting(true)
    try {
      const categories = (server.categories ?? []).filter(
        (item) => item.id !== category.id,
      )
      const updated = await editServer(token, serverId, { categories })
      syncStore.upsertServer(updated)
      toast.success('Категория удалена')
      setConfirmingDeletion(false)
      onOpenChange(false)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось удалить',
      )
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setTitle(category.title)
          setSavedTitle(category.title)
          setConfirmingDeletion(false)
        } else if (!deleting) {
          setConfirmingDeletion(false)
        }
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent className="overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {confirmingDeletion
              ? `Удалить категорию «${category.title}»?`
              : 'Категория'}
          </DialogTitle>
          <DialogDescription>
            {confirmingDeletion
              ? 'Каналы останутся на сервере, но категория будет удалена.'
              : 'Переименование и удаление категории'}
          </DialogDescription>
        </DialogHeader>
        {confirmingDeletion ? (
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={deleting}
              onClick={() => setConfirmingDeletion(false)}
            >
              Отмена
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleting}
              onClick={() => void removeCategory()}
            >
              Удалить категорию
            </Button>
          </DialogFooter>
        ) : (
          <>
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault()
                void save()
              }}
            >
              <div className="flex flex-col gap-2">
                <Label htmlFor="category-title">Название</Label>
                <Input
                  id="category-title"
                  value={title}
                  maxLength={32}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </div>
            </form>
            <Button
              type="button"
              variant="destructive"
              disabled={deleting}
              onClick={() => setConfirmingDeletion(true)}
            >
              Удалить категорию
            </Button>
            <UnsavedChangesBar placement="flow" />
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
