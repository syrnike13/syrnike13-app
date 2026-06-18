import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Trash2Icon } from '#/components/icons'
import type { DataEditServer, Emoji, FieldsServer } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { CustomEmoji } from '#/components/emoji/custom-emoji'
import { ServerSettingsAuditPanel } from '#/components/servers/server-settings-audit-panel'
import { ServerSettingsBansPanel } from '#/components/servers/server-settings-bans-panel'
import { ServerSettingsInvitesPanel } from '#/components/servers/server-settings-invites-panel'
import { ServerSettingsMembersPanel } from '#/components/servers/server-settings-members-panel'
import { ServerSettingsRolesPanel } from '#/components/servers/server-settings-roles-panel'
import type { ServerSettingsTab } from '#/components/servers/server-settings-types'
import { Button } from '#/components/ui/button'
import { FxImage } from '#/components/ui/fx-image'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { Textarea } from '#/components/ui/textarea'
import { getServerDescription } from '#/lib/channel-meta'
import { useAuth } from '#/features/auth/auth-context'
import { uploadEmoji, uploadMediaFile } from '#/features/api/media-api'
import {
  createServerEmoji,
  deleteServerEmoji,
  editServer,
  fetchServerEmojis,
} from '#/features/api/servers-api'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { serverBannerUrl, serverIconUrl } from '#/lib/media'
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

function createFilePreviewUrl(file: File) {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return null
  }
  return URL.createObjectURL(file)
}

function revokeFilePreviewUrl(url: string | null) {
  if (!url) return
  if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') {
    return
  }
  URL.revokeObjectURL(url)
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
  const [iconFile, setIconFile] = useState<File | null>(null)
  const [bannerFile, setBannerFile] = useState<File | null>(null)
  const [iconPreviewUrl, setIconPreviewUrl] = useState<string | null>(null)
  const [bannerPreviewUrl, setBannerPreviewUrl] = useState<string | null>(null)
  const [removeIcon, setRemoveIcon] = useState(false)
  const [removeBanner, setRemoveBanner] = useState(false)
  const [saving, setSaving] = useState(false)
  const iconInputRef = useRef<HTMLInputElement>(null)
  const bannerInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setName(serverName)
    setDescription(getServerDescription(server) ?? '')
    setIconFile(null)
    setBannerFile(null)
    setIconPreviewUrl(null)
    setBannerPreviewUrl(null)
    setRemoveIcon(false)
    setRemoveBanner(false)
    if (iconInputRef.current) iconInputRef.current.value = ''
    if (bannerInputRef.current) bannerInputRef.current.value = ''
  }, [server, serverName])

  useEffect(() => {
    return () => revokeFilePreviewUrl(iconPreviewUrl)
  }, [iconPreviewUrl])

  useEffect(() => {
    return () => revokeFilePreviewUrl(bannerPreviewUrl)
  }, [bannerPreviewUrl])

  function selectIconFile(file: File) {
    setIconFile(file)
    setIconPreviewUrl(createFilePreviewUrl(file))
    setRemoveIcon(false)
  }

  function selectBannerFile(file: File) {
    setBannerFile(file)
    setBannerPreviewUrl(createFilePreviewUrl(file))
    setRemoveBanner(false)
  }

  function clearIconDraft() {
    setIconFile(null)
    setIconPreviewUrl(null)
    setRemoveIcon(Boolean(server?.icon))
    if (iconInputRef.current) iconInputRef.current.value = ''
  }

  function clearBannerDraft() {
    setBannerFile(null)
    setBannerPreviewUrl(null)
    setRemoveBanner(Boolean(server?.banner))
    if (bannerInputRef.current) bannerInputRef.current.value = ''
  }

  async function saveSettings() {
    const token = auth.session?.token
    const trimmedName = name.trim()
    const trimmedDescription = description.trim()
    if (!token || !trimmedName) return

    const currentDescription = getServerDescription(server) ?? ''
    const nameChanged = trimmedName !== serverName
    const descriptionChanged = trimmedDescription !== currentDescription
    const mediaChanged = Boolean(
      iconFile || bannerFile || removeIcon || removeBanner,
    )

    if (!nameChanged && !descriptionChanged && !mediaChanged) return

    setSaving(true)
    try {
      const patch: DataEditServer = {}
      const remove: FieldsServer[] = []

      if (nameChanged) patch.name = trimmedName
      if (descriptionChanged) {
        patch.description = trimmedDescription || null
      }
      if (iconFile) {
        patch.icon = await uploadMediaFile(token, 'avatars', iconFile)
      } else if (removeIcon) {
        remove.push('Icon')
      }
      if (bannerFile) {
        patch.banner = await uploadMediaFile(token, 'backgrounds', bannerFile)
      } else if (removeBanner) {
        remove.push('Banner')
      }
      if (remove.length) patch.remove = remove

      const updated = await editServer(token, serverId, patch)
      syncStore.upsertServer(updated)
      setIconFile(null)
      setBannerFile(null)
      setIconPreviewUrl(null)
      setBannerPreviewUrl(null)
      setRemoveIcon(false)
      setRemoveBanner(false)
      if (iconInputRef.current) iconInputRef.current.value = ''
      if (bannerInputRef.current) bannerInputRef.current.value = ''
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось сохранить',
      )
    } finally {
      setSaving(false)
    }
  }

  const iconUrl = removeIcon
    ? null
    : iconPreviewUrl ?? serverIconUrl(server?.icon ?? null, { animated: true })
  const bannerUrl = removeBanner
    ? null
    : bannerPreviewUrl ??
      serverBannerUrl(server?.banner ?? null, { animated: true })
  const serverInitial = name.trim().slice(0, 1).toUpperCase() || 'S'

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
        label="Иконка сервера"
        description="Квадратная картинка для списка серверов и заголовков."
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-border bg-muted text-2xl font-semibold text-muted-foreground">
            {iconUrl ? (
              <FxImage
                src={iconUrl}
                alt="Иконка сервера"
                wrapperClassName="size-full"
                className="size-full"
              />
            ) : (
              <span>{serverInitial}</span>
            )}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Label htmlFor="server-icon">Иконка сервера</Label>
            <Input
              ref={iconInputRef}
              id="server-icon"
              type="file"
              accept="image/*"
              disabled={saving}
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) selectIconFile(file)
              }}
            />
            <p className="text-sm text-muted-foreground">
              {iconFile
                ? `Выбран файл: ${iconFile.name}`
                : removeIcon
                  ? 'Иконка будет удалена после сохранения.'
                  : 'PNG, JPG или GIF.'}
            </p>
            {iconFile || (server?.icon && !removeIcon) ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-fit text-destructive hover:text-destructive"
                disabled={saving}
                onClick={clearIconDraft}
              >
                <Trash2Icon className="size-4" />
                Удалить иконку
              </Button>
            ) : null}
            {removeIcon ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit"
                disabled={saving}
                onClick={() => setRemoveIcon(false)}
              >
                Вернуть иконку
              </Button>
            ) : null}
          </div>
        </div>
      </SettingsField>

      <SettingsField
        label="Баннер сервера"
        description="Широкая обложка для профиля сервера."
      >
        <div className="flex flex-col gap-3">
          <div className="flex h-32 w-full max-w-xl items-center justify-center overflow-hidden rounded-md border border-border bg-muted text-sm font-medium text-muted-foreground">
            {bannerUrl ? (
              <FxImage
                src={bannerUrl}
                alt="Баннер сервера"
                wrapperClassName="h-full w-full"
                className="h-full w-full"
              />
            ) : (
              <span>Баннер сервера</span>
            )}
          </div>
          <div className="flex max-w-xl flex-col gap-2">
            <Label htmlFor="server-banner">Баннер сервера</Label>
            <Input
              ref={bannerInputRef}
              id="server-banner"
              type="file"
              accept="image/*"
              disabled={saving}
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) selectBannerFile(file)
              }}
            />
            <p className="text-sm text-muted-foreground">
              {bannerFile
                ? `Выбран файл: ${bannerFile.name}`
                : removeBanner
                  ? 'Баннер будет удалён после сохранения.'
                  : 'Лучше смотрятся широкие изображения.'}
            </p>
            {bannerFile || (server?.banner && !removeBanner) ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-fit text-destructive hover:text-destructive"
                disabled={saving}
                onClick={clearBannerDraft}
              >
                <Trash2Icon className="size-4" />
                Удалить баннер
              </Button>
            ) : null}
            {removeBanner ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit"
                disabled={saving}
                onClick={() => setRemoveBanner(false)}
              >
                Вернуть баннер
              </Button>
            ) : null}
          </div>
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
    case 'overview':
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
    case 'bans':
      return <ServerSettingsBansPanel serverId={serverId} />
    case 'invites':
      return <ServerSettingsInvitesPanel serverId={serverId} />
    case 'audit':
      return <ServerSettingsAuditPanel serverId={serverId} />
    default:
      return null
  }
}
