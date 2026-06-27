import { useState } from 'react'
import type { Category } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
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
  serverId,
  category,
  open,
  onOpenChange,
}: CategorySettingsDialogProps) {
  const auth = useAuth()
  const [title, setTitle] = useState(category.title)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmingDeletion, setConfirmingDeletion] = useState(false)

  async function save() {
    const token = auth.session?.token
    const trimmed = title.trim()
    if (!token || !trimmed) return

    const server = syncStore.getState().servers[serverId]
    if (!server) return

    setSaving(true)
    try {
      const categories = (server.categories ?? []).map((item) =>
        item.id === category.id ? { ...item, title: trimmed } : item,
      )
      const updated = await editServer(token, serverId, { categories })
      syncStore.upsertServer(updated)
      toast.success('Категория обновлена')
      onOpenChange(false)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось сохранить',
      )
    } finally {
      setSaving(false)
    }
  }

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
          setConfirmingDeletion(false)
        } else if (!deleting) {
          setConfirmingDeletion(false)
        }
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent>
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
              <Button type="submit" disabled={saving || !title.trim()}>
                Сохранить
              </Button>
            </form>
            <Button
              type="button"
              variant="destructive"
              disabled={deleting}
              onClick={() => setConfirmingDeletion(true)}
            >
              Удалить категорию
            </Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
