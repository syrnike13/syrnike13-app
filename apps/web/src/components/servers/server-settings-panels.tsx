import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Trash2Icon } from '#/components/icons'
import type { Emoji } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { CustomEmoji } from '#/components/emoji/custom-emoji'
import { ServerSettingsMembersPanel } from '#/components/servers/server-settings-members-panel'
import { ServerSettingsRolesPanel } from '#/components/servers/server-settings-roles-panel'
import type { ServerSettingsTab } from '#/components/servers/server-settings-types'
import { Button } from '#/components/ui/button'
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
} from '#/features/api/servers-api'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { cn } from '#/lib/utils'

type ServerSettingsPanelsProps = {
  serverId: string
  tab: ServerSettingsTab
}

function SettingsField({
  label,
  description,
  children,
  className,
}: {
  label: string
  description?: string
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={cn(
        'border-b border-border/60 py-6 last:border-b-0',
        className,
      )}
    >
      <div className="mb-4">
        <h3 className="text-base font-semibold">{label}</h3>
        {description ? (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div>{children}</div>
    </section>
  )
}

function ServerSettingsGeneralPanel({
  serverId,
  serverName,
}: {
  serverId: string
  serverName: string
}) {
  const auth = useAuth()
  const server = useSyncStore((s) => s.servers[serverId])
  const [name, setName] = useState(serverName)
  const [description, setDescription] = useState(
    getServerDescription(server) ?? '',
  )
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setName(serverName)
    setDescription(getServerDescription(server) ?? '')
  }, [server, serverName])

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
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось сохранить',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void saveSettings()
      }}
    >
      <SettingsField label="Название">
        <div className="flex flex-col gap-2">
          <Label htmlFor="server-rename" className="sr-only">
            Название
          </Label>
          <Input
            id="server-rename"
            value={name}
            maxLength={32}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
      </SettingsField>

      <SettingsField
        label="Описание"
        description="Расскажите участникам, о чём этот сервер."
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="server-description" className="sr-only">
            Описание
          </Label>
          <Textarea
            id="server-description"
            value={description}
            rows={4}
            maxLength={1024}
            placeholder="О сервере"
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
      </SettingsField>

      <div className="pt-2">
        <Button type="submit" disabled={saving || !name.trim()}>
          Сохранить
        </Button>
      </div>
    </form>
  )
}

function ServerSettingsEmojiPanel({ serverId }: { serverId: string }) {
  const auth = useAuth()
  const [emojis, setEmojis] = useState<Emoji[]>([])
  const [emojiLoading, setEmojiLoading] = useState(false)
  const [emojiName, setEmojiName] = useState('')
  const [emojiUploading, setEmojiUploading] = useState(false)
  const emojiFileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
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
  }, [auth.session?.token, serverId])

  async function handleEmojiUpload(file: File) {
    const token = auth.session?.token
    const trimmedName = emojiName.trim()
    if (!token || !trimmedName) {
      toast.error('Укажите имя emoji')
      if (emojiFileRef.current) emojiFileRef.current.value = ''
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
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось создать emoji',
      )
      if (emojiFileRef.current) emojiFileRef.current.value = ''
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
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось удалить',
      )
    }
  }

  return (
    <>
      <SettingsField
        label="Добавить emoji"
        description="Имя — латиница, без пробелов. Файл — изображение."
      >
        <div className="space-y-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="emoji-name">Имя</Label>
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
        </div>
      </SettingsField>

      <SettingsField label="Серверные emoji">
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
      </SettingsField>
    </>
  )
}

export function ServerSettingsPanelContent({
  serverId,
  tab,
}: ServerSettingsPanelsProps) {
  const serverName = useSyncStore((s) => s.servers[serverId]?.name ?? '')

  switch (tab) {
    case 'general':
      return (
        <ServerSettingsGeneralPanel
          serverId={serverId}
          serverName={serverName}
        />
      )
    case 'emoji':
      return <ServerSettingsEmojiPanel serverId={serverId} />
    case 'roles':
      return <ServerSettingsRolesPanel serverId={serverId} />
    case 'members':
      return <ServerSettingsMembersPanel serverId={serverId} />
    default:
      return null
  }
}
