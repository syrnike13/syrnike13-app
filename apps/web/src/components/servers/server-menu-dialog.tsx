import { useEffect, useRef, useState } from 'react'
import { LogOutIcon, Trash2Icon } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import type { Emoji } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { CustomEmoji } from '#/components/emoji/custom-emoji'
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
import { Textarea } from '#/components/ui/textarea'
import { getServerDescription } from '#/lib/channel-meta'
import { useAuth } from '#/features/auth/auth-context'
import { uploadEmoji } from '#/features/api/media-api'
import {
  createServerEmoji,
  deleteServerEmoji,
  editServer,
  fetchServerEmojis,
  leaveServer,
} from '#/features/api/servers-api'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { cn } from '#/lib/utils'

type ServerMenuDialogProps = {
  serverId: string
  serverName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

type ServerSettingsTab = 'general' | 'emoji' | 'roles'

const TAB_LABELS: Record<ServerSettingsTab, string> = {
  general: 'Основное',
  emoji: 'Emoji',
  roles: 'Роли',
}

export function ServerMenuDialog({
  serverId,
  serverName,
  open,
  onOpenChange,
}: ServerMenuDialogProps) {
  const auth = useAuth()
  const navigate = useNavigate()
  const [tab, setTab] = useState<ServerSettingsTab>('general')
  const server = useSyncStore((s) => s.servers[serverId])
  const [name, setName] = useState(serverName)
  const [description, setDescription] = useState(
    getServerDescription(server) ?? '',
  )
  const [saving, setSaving] = useState(false)
  const [leaving, setLeaving] = useState(false)

  const [emojis, setEmojis] = useState<Emoji[]>([])
  const [emojiLoading, setEmojiLoading] = useState(false)
  const [emojiName, setEmojiName] = useState('')
  const [emojiUploading, setEmojiUploading] = useState(false)
  const emojiFileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setName(serverName)
      setDescription(getServerDescription(server) ?? '')
      setTab('general')
    }
  }, [open, server, serverName])

  useEffect(() => {
    if (!open || tab !== 'emoji') return
    const token = auth.session?.token
    if (!token) return

    let cancelled = false
    setEmojiLoading(true)
    void fetchServerEmojis(token, serverId)
      .then((list) => {
        if (!cancelled) {
          setEmojis(list)
          for (const emoji of list) {
            syncStore.upsertEmoji(emoji)
          }
        }
      })
      .catch((error) => {
        if (!cancelled) {
          toast.error(
            error instanceof Error ? error.message : 'Не удалось загрузить emoji',
          )
        }
      })
      .finally(() => {
        if (!cancelled) setEmojiLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [auth.session?.token, open, serverId, tab])

  async function saveSettings() {
    const token = auth.session?.token
    const trimmedName = name.trim()
    const trimmedDescription = description.trim()
    if (!token || !trimmedName) return

    const currentDescription = getServerDescription(server) ?? ''
    const nameChanged = trimmedName !== serverName
    const descriptionChanged = trimmedDescription !== currentDescription

    if (!nameChanged && !descriptionChanged) return

    setSaving(true)
    try {
      const updated = await editServer(token, serverId, {
        ...(nameChanged ? { name: trimmedName } : {}),
        ...(descriptionChanged
          ? { description: trimmedDescription || null }
          : {}),
      })
      syncStore.upsertServer(updated)
      toast.success('Сервер обновлён')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось сохранить',
      )
    } finally {
      setSaving(false)
    }
  }

  async function handleLeave() {
    const token = auth.session?.token
    if (!token) return
    if (
      !window.confirm(
        `Покинуть сервер «${serverName}»? Вы потеряете доступ к его каналам.`,
      )
    ) {
      return
    }

    setLeaving(true)
    try {
      await leaveServer(token, serverId)
      syncStore.removeServer(serverId)
      syncStore.setSelectedServerId(null)
      onOpenChange(false)
      toast.success('Вы покинули сервер')
      await navigate({ to: '/app', search: { tab: 'online' } })
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось покинуть сервер',
      )
    } finally {
      setLeaving(false)
    }
  }

  async function handleEmojiUpload(file: File) {
    const token = auth.session?.token
    const trimmedName = emojiName.trim()
    if (!token || !trimmedName) {
      toast.error('Укажите имя emoji')
      return
    }

    setEmojiUploading(true)
    try {
      const autumnId = await uploadEmoji(token, file)
      const created = await createServerEmoji(
        token,
        autumnId,
        serverId,
        trimmedName,
      )
      syncStore.upsertEmoji(created)
      setEmojis((prev) => [...prev, created])
      setEmojiName('')
      if (emojiFileRef.current) emojiFileRef.current.value = ''
      toast.success('Emoji добавлен')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось создать emoji',
      )
    } finally {
      setEmojiUploading(false)
    }
  }

  async function handleEmojiDelete(emojiId: string) {
    const token = auth.session?.token
    if (!token) return
    if (!window.confirm('Удалить этот emoji?')) return

    try {
      await deleteServerEmoji(token, emojiId)
      syncStore.removeEmoji(emojiId)
      setEmojis((prev) => prev.filter((emoji) => emoji._id !== emojiId))
      toast.success('Emoji удалён')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось удалить',
      )
    }
  }

  const roles = server?.roles
    ? Object.values(server.roles).sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))
    : []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{serverName}</DialogTitle>
          <DialogDescription>Настройки сервера</DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {(Object.keys(TAB_LABELS) as ServerSettingsTab[]).map((key) => (
            <button
              key={key}
              type="button"
              className={cn(
                'flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors',
                tab === key
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={() => setTab(key)}
            >
              {TAB_LABELS[key]}
            </button>
          ))}
        </div>

        {tab === 'general' ? (
          <>
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault()
                void saveSettings()
              }}
            >
              <div className="flex flex-col gap-2">
                <Label htmlFor="server-rename">Название</Label>
                <Input
                  id="server-rename"
                  value={name}
                  maxLength={32}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="server-description">Описание</Label>
                <Textarea
                  id="server-description"
                  value={description}
                  rows={3}
                  maxLength={1024}
                  placeholder="О сервере"
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>
              <Button type="submit" disabled={saving || !name.trim()}>
                Сохранить
              </Button>
            </form>
            <Button
              type="button"
              variant="destructive"
              disabled={leaving}
              onClick={() => void handleLeave()}
            >
              <LogOutIcon className="size-4" />
              Покинуть сервер
            </Button>
          </>
        ) : null}

        {tab === 'emoji' ? (
          <div className="space-y-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="emoji-name">Имя (латиница)</Label>
              <Input
                id="emoji-name"
                value={emojiName}
                maxLength={32}
                placeholder="party_parrot"
                onChange={(event) => setEmojiName(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="emoji-file">Файл</Label>
              <Input
                id="emoji-file"
                ref={emojiFileRef}
                type="file"
                accept="image/*"
                disabled={emojiUploading}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) void handleEmojiUpload(file)
                }}
              />
            </div>
            {emojiLoading ? (
              <p className="text-sm text-muted-foreground">Загрузка…</p>
            ) : emojis.length === 0 ? (
              <p className="text-sm text-muted-foreground">Нет серверных emoji</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {emojis.map((emoji) => (
                  <li
                    key={emoji._id}
                    className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5"
                  >
                    <CustomEmoji emojiId={emoji._id} name={emoji.name} size="md" />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      :{emoji.name}:
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0"
                      title="Удалить"
                      onClick={() => void handleEmojiDelete(emoji._id)}
                    >
                      <Trash2Icon className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        {tab === 'roles' ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Список ролей (только просмотр). Редактирование — в следующих версиях.
            </p>
            {roles.length === 0 ? (
              <p className="text-sm text-muted-foreground">Нет ролей</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {roles.map((role) => (
                  <li
                    key={role._id}
                    className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
                  >
                    <span className="truncate font-medium">{role.name}</span>
                    <span className="text-xs text-muted-foreground">
                      rank {role.rank ?? 0}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
