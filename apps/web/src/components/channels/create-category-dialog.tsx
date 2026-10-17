import { useTranslations } from '@syrnike13/ui/i18n'
import { useState } from 'react'
import { Effect } from 'effect'
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
import { editServerEffect } from '#/features/api/servers-api'
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
  const t = useTranslations('channels.createCategory')
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
    await Effect.runPromise(
      Effect.gen(function*() {
        const categories = [
          ...(server.categories ?? []),
          {
            id: createCategoryId(),
            title: trimmed,
            channels: [],
          },
        ]
        const updated = yield* editServerEffect(token, serverId, {
          categories,
        })
        yield* Effect.sync(() => {
          syncStore.upsertServer(updated)
          toast.success(t('success', { title: trimmed }))
          onOpenChange(false)
          setTitle('')
        })
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            toast.error(
              error instanceof Error ? error.message : t('error'),
            )
          }),
        ),
        Effect.ensuring(Effect.sync(() => setSaving(false))),
      ),
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="new-category-title">{t('name')}</Label>
            <Input
              id="new-category-title"
              value={title}
              maxLength={32}
              placeholder={t('placeholder')}
              autoFocus
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={saving || !title.trim()}>
            {t('submit')}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
