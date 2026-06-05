import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { useAuth } from '#/features/auth/auth-context'
import { editServer } from '#/features/api/servers-api'
import { syncStore } from '#/features/sync/sync-store'
import { createCategoryId } from '#/lib/channel-sidebar-layout'

type CreateCategoryDialogProps = {
  serverId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CreateCategoryDialog({
  serverId,
  open,
  onOpenChange,
}: CreateCategoryDialogProps) {
  const auth = useAuth()
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit() {
    const token = auth.session?.token
    const trimmed = title.trim()
    if (!token || !trimmed) return

    const server = syncStore.getState().servers[serverId]
    if (!server) return

    setSaving(true)
    try {
      const categories = [
        ...(server.categories ?? []),
        {
          id: createCategoryId(),
          title: trimmed,
          channels: [],
        },
      ]
      const updated = await editServer(token, serverId, { categories })
      syncStore.upsertServer(updated)
      toast.success(`Категория «${trimmed}» создана`)
      onOpenChange(false)
      setTitle('')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось создать',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Создать категорию</DialogTitle>
          <DialogDescription>
            Категории группируют каналы в боковой панели
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="new-category-title">Название</Label>
            <Input
              id="new-category-title"
              value={title}
              maxLength={32}
              placeholder="Текстовые каналы"
              autoFocus
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={saving || !title.trim()}>
            Создать
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
