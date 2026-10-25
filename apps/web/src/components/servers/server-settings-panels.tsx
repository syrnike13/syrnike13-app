import { useEffect, useRef, useState } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'
import { PencilIcon, Trash2Icon } from '#/components/icons'
import type {
  DataEditServer,
  Emoji,
  FieldsServer,
  SystemMessageChannels,
} from '@syrnike13/api-types'
import { Effect, Fiber } from 'effect'

import { CustomEmoji } from '#/components/emoji/custom-emoji'
import { ServerSettingsAuditPanel } from '#/components/servers/server-settings-audit-panel'
import { ServerSettingsBansPanel } from '#/components/servers/server-settings-bans-panel'
import { ServerSettingsInvitesPanel } from '#/components/servers/server-settings-invites-panel'
import { ServerSettingsMembersPanel } from '#/components/servers/server-settings-members-panel'
import { ServerSettingsRolesPanel } from '#/components/servers/server-settings-roles-panel'
import type { ServerSettingsTab } from '#/components/servers/server-settings-types'
import { useDraftRegistration } from '#/components/settings/draft-controller-context'
import { Button } from '@syrnike13/ui/primitives/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@syrnike13/ui/primitives/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@syrnike13/ui/primitives/dropdown-menu'
import { Empty, EmptyDescription } from '@syrnike13/ui/primitives/empty'
import { useImageCropper } from '#/components/media/image-crop-dialog'
import { SettingsBlock } from '#/components/settings/settings-panels'
import { Spinner } from '@syrnike13/ui/primitives/spinner'
import { Field, FieldLabel } from '@syrnike13/ui/primitives/field'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@syrnike13/ui/primitives/item'
import { FxImage } from '#/components/ui/fx-image'
import { Input } from '@syrnike13/ui/primitives/input'
import { Label } from '@syrnike13/ui/primitives/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@syrnike13/ui/primitives/select'
import { Textarea } from '@syrnike13/ui/primitives/textarea'
import { getServerDescription } from '#/lib/channel-meta'
import { useAuth } from '#/features/auth/auth-context'
import {
  uploadEmojiEffect,
  uploadMediaFileEffect,
} from '#/features/api/media-api'
import {
  createServerEmojiEffect,
  deleteServerEmojiEffect,
  editServerEffect,
  fetchServerEmojisEffect,
} from '#/features/api/servers-api'
import { listServerChannels } from '#/features/sync/selectors'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { isServerVoiceChannel } from '#/lib/channel-voice'
import { serverBannerUrl, serverIconUrl } from '#/lib/media'

type ServerSettingsPanelsProps = {
  serverId: string
  tab: ServerSettingsTab
}

const SYSTEM_MESSAGES_NONE = '__none__'
const SYSTEM_MESSAGES_MIXED = '__mixed__'
const SYSTEM_MESSAGE_KEYS = [
  'user_joined',
  'user_left',
  'user_kicked',
  'user_banned',
] as const
const SERVER_EMOJI_NAME_PATTERN = /^[A-Za-z0-9_]+$/

/** Server banners crop like Discord's 960×540. */
const SERVER_BANNER_ASPECT = 16 / 9

/** Discord: an emoji without a typed name takes the file name. */
function emojiNameFromFile(file: File) {
  return file.name
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
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

function systemMessageChannelValue(
  systemMessages: SystemMessageChannels | null | undefined,
) {
  const channelIds = SYSTEM_MESSAGE_KEYS.flatMap((key) => {
    const channelId = systemMessages?.[key]
    return channelId ? [channelId] : []
  })
  const uniqueChannelIds = [...new Set(channelIds)]
  if (uniqueChannelIds.length === 0) return SYSTEM_MESSAGES_NONE
  if (uniqueChannelIds.length === 1) return uniqueChannelIds[0]
  return SYSTEM_MESSAGES_MIXED
}

function buildSystemMessageChannels(channelId: string): SystemMessageChannels {
  return {
    user_joined: channelId,
    user_left: channelId,
    user_kicked: channelId,
    user_banned: channelId,
  }
}

function ServerProfilePreview({
  name,
  description,
  iconUrl,
  bannerUrl,
  serverInitial,
  iconRemoved,
  bannerRemoved,
  saving,
  onUploadIcon,
  onRemoveIcon,
  onRestoreIcon,
  onUploadBanner,
  onRemoveBanner,
  onRestoreBanner,
}: {
  name: string
  description: string
  iconUrl: string | null
  bannerUrl: string | null
  serverInitial: string
  iconRemoved: boolean
  bannerRemoved: boolean
  saving: boolean
  onUploadIcon: () => void
  onRemoveIcon: () => void
  onRestoreIcon: () => void
  onUploadBanner: () => void
  onRemoveBanner: () => void
  onRestoreBanner: () => void
}) {
  const t = useTranslations('servers.settings')
  const previewName = name.trim() || t('serverNamePlaceholder')
  const previewDescription =
    description.trim() || t('serverDescriptionPlaceholder')

  return (
    <aside aria-label={t('previewAria')}>
      <p className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {t('preview')}
      </p>
      <div className="overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm">
        <DropdownMenu>
          {/* eslint-disable-next-line design/no-lookalike -- banner preview opens the image menu */}
          <DropdownMenuTrigger render={<button
              type="button"
              aria-label={t('bannerMenuAria')}
              disabled={saving}
              className="group/banner relative block h-28 w-full cursor-pointer overflow-hidden bg-linear-to-br from-primary/30 via-accent to-muted text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default" />}>
              {bannerUrl ? (
                <FxImage
                  src={bannerUrl}
                  alt={t('bannerPreviewAlt')}
                  wrapperClassName="size-full"
                  className="size-full"
                />
              ) : null}
              <span
                aria-hidden="true"
                className="absolute inset-0 flex items-center justify-center gap-1.5 bg-background/55 text-xs font-medium text-foreground opacity-0 transition-opacity group-hover/banner:opacity-100 group-focus-visible/banner:opacity-100 group-data-[popup-open]/banner:opacity-100 motion-reduce:transition-none"
              >
                <PencilIcon className="size-4" />
                {t('edit')}
              </span>
            </DropdownMenuTrigger>
          <DropdownMenuContent align="center" side="bottom">
            <DropdownMenuGroup>
              <DropdownMenuItem
                aria-label={t('uploadBanner')}
                onClick={onUploadBanner}
                disabled={saving}
              >
                {t('upload')}
              </DropdownMenuItem>
              {bannerRemoved ? (
                <DropdownMenuItem
                  aria-label={t('restoreBanner')}
                  onClick={onRestoreBanner}
                  disabled={saving}
                >
                  {t('restore')}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  aria-label={t('removeBanner')}
                  variant="destructive"
                  disabled={saving || !bannerUrl}
                  onClick={onRemoveBanner}
                >
                  <Trash2Icon />
                  {t('remove')}
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="relative px-4 pb-5 pt-11">
          <div className="absolute -top-8 left-4 z-10">
            <DropdownMenu>
              {/* eslint-disable-next-line design/no-lookalike -- icon preview opens the image menu */}
              <DropdownMenuTrigger render={<button
                  type="button"
                  aria-label={t('iconMenuAria')}
                  disabled={saving}
                  className="group/icon relative flex size-16 cursor-pointer items-center justify-center overflow-hidden rounded-2xl border-4 border-card bg-primary text-xl font-semibold text-primary-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default" />}>
                  {iconUrl ? (
                    <FxImage
                      src={iconUrl}
                      alt={t('iconPreviewAlt')}
                      wrapperClassName="size-full"
                      className="size-full"
                    />
                  ) : (
                    <span>{serverInitial}</span>
                  )}
                  <span
                    aria-hidden="true"
                    className="absolute inset-0 flex items-center justify-center bg-background/60 text-foreground opacity-0 transition-opacity group-hover/icon:opacity-100 group-focus-visible/icon:opacity-100 group-data-[popup-open]/icon:opacity-100 motion-reduce:transition-none"
                  >
                    <PencilIcon className="size-4" />
                  </span>
                </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="right">
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    aria-label={t('uploadIcon')}
                    onClick={onUploadIcon}
                    disabled={saving}
                  >
                    {t('upload')}
                  </DropdownMenuItem>
                  {iconRemoved ? (
                    <DropdownMenuItem
                      aria-label={t('restoreIcon')}
                      onClick={onRestoreIcon}
                      disabled={saving}
                    >
                      {t('restore')}
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem
                      aria-label={t('removeIcon')}
                      variant="destructive"
                      disabled={saving || !iconUrl}
                      onClick={onRemoveIcon}
                    >
                      <Trash2Icon />
                      {t('remove')}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <h3 className="truncate text-lg font-semibold text-card-foreground">
            {previewName}
          </h3>
          <p className="mt-1 min-h-10 break-words text-sm leading-5 text-muted-foreground">
            {previewDescription}
          </p>
        </div>
      </div>
    </aside>
  )
}

function ServerSettingsGeneralPanel({
  serverId,
  serverName,
}: {
  serverId: string
  serverName: string
}) {
  const t = useTranslations('servers.settings')
  const tm = useTranslations('media')
  const auth = useAuth()
  const { cropImage, cropDialog } = useImageCropper()
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

  async function saveSettings(): Promise<boolean> {
    const token = auth.session?.token
    const trimmedName = name.trim()
    const trimmedDescription = description.trim()
    if (!token || !trimmedName) return false

    const currentDescription = getServerDescription(server) ?? ''
    const nameChanged = trimmedName !== serverName
    const descriptionChanged = trimmedDescription !== currentDescription
    const mediaChanged = Boolean(
      iconFile || bannerFile || removeIcon || removeBanner,
    )

    if (!nameChanged && !descriptionChanged && !mediaChanged) {
      return true
    }

    setSaving(true)
    return Effect.runPromise(
      Effect.gen(function*() {
        const patch: DataEditServer = {}
        const remove: FieldsServer[] = []

        if (nameChanged) patch.name = trimmedName
        if (descriptionChanged) {
          if (trimmedDescription) {
            patch.description = trimmedDescription
          } else {
            remove.push('Description')
          }
        }
        if (iconFile) {
          patch.icon = yield* uploadMediaFileEffect(
            token,
            'icons',
            iconFile,
            tm,
          )
        } else if (removeIcon) {
          remove.push('Icon')
        }
        if (bannerFile) {
          patch.banner = yield* uploadMediaFileEffect(
            token,
            'banners',
            bannerFile,
            tm,
          )
        } else if (removeBanner) {
          remove.push('Banner')
        }
        if (remove.length) patch.remove = remove

        const updated = yield* editServerEffect(token, serverId, patch)
        yield* Effect.sync(() => {
          syncStore.upsertServer(updated)
          setIconFile(null)
          setBannerFile(null)
          setIconPreviewUrl(null)
          setBannerPreviewUrl(null)
          setRemoveIcon(false)
          setRemoveBanner(false)
          if (iconInputRef.current) iconInputRef.current.value = ''
          if (bannerInputRef.current) bannerInputRef.current.value = ''
        })
      }).pipe(
        Effect.match({
          onFailure: () => {
            return false
          },
          onSuccess: () => true,
        }),
        Effect.ensuring(Effect.sync(() => setSaving(false))),
      ),
    )
  }

  const iconUrl = removeIcon
    ? null
    : iconPreviewUrl ?? serverIconUrl(server?.icon ?? null, { animated: true })
  const bannerUrl = removeBanner
    ? null
    : bannerPreviewUrl ??
      serverBannerUrl(server?.banner ?? null, { animated: true })
  const serverInitial = name.trim().slice(0, 1).toUpperCase() || 'S'
  const isDirty =
    name.trim() !== serverName ||
    description.trim() !== (getServerDescription(server) ?? '') ||
    Boolean(iconFile || bannerFile || removeIcon || removeBanner)

  function resetDraft() {
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
    return true
  }

  useDraftRegistration({
    isDirty,
    isSaving: saving,
    save: saveSettings,
    reset: resetDraft,
  })

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void saveSettings()
      }}
    >
      <section className="pb-6">
        <div>
          <h2 className="text-xl font-semibold">{t('profileTitle')}</h2>
          <p className="mt-1 max-w-2xl text-sm leading-5 text-muted-foreground">
            {t('profileDescription')}
          </p>
        </div>

        <div className="mt-6 grid gap-8 settings-panels-grid xl:items-start">
          <div className="min-w-0 space-y-6">
            <div className="space-y-2">
              <Label htmlFor="server-rename">{t('name')}</Label>
              <Input
                id="server-rename"
                value={name}
                maxLength={32}
                onChange={(event) => setName(event.target.value)}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-baseline justify-between gap-3">
                <Label htmlFor="server-description">{t('description')}</Label>
                <span className="text-xs text-muted-foreground">
                  {description.length}/1024
                </span>
              </div>
              <Textarea
                id="server-description"
                value={description}
                rows={5}
                maxLength={1024}
                placeholder={t('descriptionPlaceholder')}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>

            <Input
              ref={iconInputRef}
              id="server-icon"
              type="file"
              accept="image/*"
              disabled={saving}
              aria-label={t('iconAria')}
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) cropImage(file, { kind: 'rect', aspect: 1 }, selectIconFile)
              }}
            />
            <Input
              ref={bannerInputRef}
              id="server-banner"
              type="file"
              accept="image/*"
              disabled={saving}
              aria-label={t('bannerAria')}
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) {
                  cropImage(file, { kind: 'rect', aspect: SERVER_BANNER_ASPECT }, selectBannerFile)
                }
              }}
            />
          </div>

          {cropDialog}
          <ServerProfilePreview
            name={name}
            description={description}
            iconUrl={iconUrl}
            bannerUrl={bannerUrl}
            serverInitial={serverInitial}
            iconRemoved={removeIcon}
            bannerRemoved={removeBanner}
            saving={saving}
            onUploadIcon={() => iconInputRef.current?.click()}
            onRemoveIcon={clearIconDraft}
            onRestoreIcon={() => setRemoveIcon(false)}
            onUploadBanner={() => bannerInputRef.current?.click()}
            onRemoveBanner={clearBannerDraft}
            onRestoreBanner={() => setRemoveBanner(false)}
          />
        </div>
      </section>

    </form>
  )
}

function ServerSettingsEngagementPanel({ serverId }: { serverId: string }) {
  const t = useTranslations('servers.settings')
  const auth = useAuth()
  const server = useSyncStore((s) => s.servers[serverId])
  const systemMessageChannels = useSyncStore((s) =>
    listServerChannels(s, serverId).filter(
      (channel) => !isServerVoiceChannel(channel),
    ),
  )
  const [systemMessagesChannelId, setSystemMessagesChannelId] = useState(() =>
    systemMessageChannelValue(server?.system_messages),
  )
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setSystemMessagesChannelId(
      systemMessageChannelValue(server?.system_messages),
    )
  }, [server?.system_messages])

  async function saveSettings(): Promise<boolean> {
    const token = auth.session?.token
    if (!token || !server) return false

    const currentValue = systemMessageChannelValue(server.system_messages)
    if (systemMessagesChannelId === currentValue) return true

    const patch: DataEditServer = {}
    if (systemMessagesChannelId === SYSTEM_MESSAGES_NONE) {
      patch.remove = ['SystemMessages']
    } else if (systemMessagesChannelId !== SYSTEM_MESSAGES_MIXED) {
      patch.system_messages = buildSystemMessageChannels(
        systemMessagesChannelId,
      )
    }

    setSaving(true)
    return Effect.runPromise(
      editServerEffect(token, serverId, patch).pipe(
        Effect.tap((updated) =>
          Effect.sync(() => {
            syncStore.upsertServer(updated)
            setSystemMessagesChannelId(
              systemMessageChannelValue(updated.system_messages),
            )
          }),
        ),
        Effect.match({
          onFailure: () => {
            return false
          },
          onSuccess: () => true,
        }),
        Effect.ensuring(Effect.sync(() => setSaving(false))),
      ),
    )
  }

  const isDirty =
    systemMessagesChannelId !==
    systemMessageChannelValue(server?.system_messages)

  function resetDraft() {
    setSystemMessagesChannelId(
      systemMessageChannelValue(server?.system_messages),
    )
    return true
  }

  useDraftRegistration({
    isDirty,
    isSaving: saving,
    save: saveSettings,
    reset: resetDraft,
  })

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void saveSettings()
      }}
    >
      <div>
        <h2 className="text-xl font-semibold">{t('engagementTitle')}</h2>
        <p className="mt-1 max-w-2xl text-sm leading-5 text-muted-foreground">
          {t('engagementDescription')}
        </p>
      </div>

      <SettingsBlock
        title={t('systemMessages')}
        description={t('systemMessagesDescription')}
      >
        <div className="flex max-w-xl flex-col gap-2">
          <Label htmlFor="server-system-messages-channel">
            {t('systemMessagesChannel')}
          </Label>
          <Select
            items={[
              { value: SYSTEM_MESSAGES_NONE, label: t('dontSend') },
              ...(systemMessagesChannelId === SYSTEM_MESSAGES_MIXED
                ? [
                    {
                      value: SYSTEM_MESSAGES_MIXED,
                      label: t('mixedChannels'),
                    },
                  ]
                : []),
              ...systemMessageChannels.map((channel) => ({
                value: channel._id,
                label: `#${channel.name}`,
              })),
            ]}
            value={systemMessagesChannelId}
            disabled={saving}
            onValueChange={(value) => {
              if (value != null) setSystemMessagesChannelId(value)
            }}
          >
            <SelectTrigger
              id="server-system-messages-channel"
              className="w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SYSTEM_MESSAGES_NONE}>
                {t('dontSend')}
              </SelectItem>
              {systemMessagesChannelId === SYSTEM_MESSAGES_MIXED ? (
                <SelectItem value={SYSTEM_MESSAGES_MIXED} disabled>
                  {t('mixedChannels')}
                </SelectItem>
              ) : null}
              {systemMessageChannels.map((channel) => (
                <SelectItem key={channel._id} value={channel._id}>
                  #{channel.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </SettingsBlock>

    </form>
  )
}

function ServerSettingsEmojiPanel({ serverId }: { serverId: string }) {
  const t = useTranslations('servers.settings')
  const tm = useTranslations('media')
  const auth = useAuth()
  const [emojis, setEmojis] = useState<Emoji[]>([])
  const [emojiLoading, setEmojiLoading] = useState(false)
  const [emojiName, setEmojiName] = useState('')
  const [emojiUploading, setEmojiUploading] = useState(false)
  const [emojiPendingDeletion, setEmojiPendingDeletion] =
    useState<Emoji | null>(null)
  const [emojiDeleting, setEmojiDeleting] = useState(false)
  const emojiFileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const token = auth.session?.token
    if (!token) return

    setEmojiLoading(true)
    const fiber = Effect.runFork(
      fetchServerEmojisEffect(token, serverId).pipe(
        Effect.matchEffect({
          onFailure: () =>
            Effect.sync(() => {
              setEmojiLoading(false)
            }),
          onSuccess: (list) =>
            Effect.sync(() => {
          setEmojis(list)
          for (const emoji of list) {
            syncStore.upsertEmoji(emoji)
          }
              setEmojiLoading(false)
            }),
        }),
      ),
    )

    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [auth.session?.token, serverId])

  async function handleEmojiUpload(file: File) {
    const token = auth.session?.token
    // Discord: without a typed name the file name becomes the emoji name.
    const trimmedName = emojiName.trim() || emojiNameFromFile(file)
    if (!token || !trimmedName) {
      if (emojiFileRef.current) emojiFileRef.current.value = ''
      return
    }
    if (!SERVER_EMOJI_NAME_PATTERN.test(trimmedName)) {
      if (emojiFileRef.current) emojiFileRef.current.value = ''
      return
    }

    setEmojiUploading(true)
    await Effect.runPromise(
      Effect.gen(function*() {
        const autumnId = yield* uploadEmojiEffect(token, file, tm)
        const created = yield* createServerEmojiEffect(
          token,
          autumnId,
          serverId,
          trimmedName,
        )
        yield* Effect.sync(() => {
          syncStore.upsertEmoji(created)
          setEmojis((prev) => [...prev, created])
          setEmojiName('')
          if (emojiFileRef.current) emojiFileRef.current.value = ''
        })
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            if (emojiFileRef.current) emojiFileRef.current.value = ''
          }),
        ),
        Effect.ensuring(Effect.sync(() => setEmojiUploading(false))),
      ),
    )
  }

  async function handleEmojiDelete() {
    const token = auth.session?.token
    const emoji = emojiPendingDeletion
    if (!token || !emoji) return

    setEmojiDeleting(true)
    await Effect.runPromise(
      deleteServerEmojiEffect(token, emoji._id).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            syncStore.removeEmoji(emoji._id)
            setEmojis((prev) =>
              prev.filter((entry) => entry._id !== emoji._id),
            )
            setEmojiPendingDeletion(null)
          }),
        ),
        Effect.catch(() =>
          Effect.sync(() => {
          }),
        ),
        Effect.ensuring(Effect.sync(() => setEmojiDeleting(false))),
      ),
    )
  }

  return (
    <>
      <SettingsBlock
        title={t('addEmoji')}
        description={t('addEmojiDescription')}
      >
        <div className="flex items-end gap-2">
          <Field className="flex-1">
            <FieldLabel htmlFor="emoji-name">{t('nameLabel')}</FieldLabel>
            <Input
              id="emoji-name"
              value={emojiName}
              maxLength={32}
              // eslint-disable-next-line design/no-hardcoded-text -- example emoji identifier, not UI copy
              placeholder="party_parrot"
              onChange={(event) => setEmojiName(event.target.value)}
            />
          </Field>
          <input
            ref={emojiFileRef}
            type="file"
            accept="image/*"
            hidden
            aria-label={t('fileLabel')}
            disabled={emojiUploading}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void handleEmojiUpload(file)
            }}
          />
          <Button
            type="button"
            disabled={emojiUploading}
            onClick={() => emojiFileRef.current?.click()}
          >
            {emojiUploading ? <Spinner /> : null}
            {t('uploadEmoji')}
          </Button>
        </div>
      </SettingsBlock>

      <SettingsBlock title={t('serverEmoji')}>
        {emojiLoading ? (
          <p className="text-sm text-muted-foreground">{t('loading')}</p>
        ) : emojis.length === 0 ? (
          <Empty>
            <EmptyDescription>{t('noEmoji')}</EmptyDescription>
          </Empty>
        ) : (
          <ItemGroup className="gap-0">
            {emojis.map((emoji) => (
              <Item key={emoji._id} size="sm">
                <ItemMedia>
                  <CustomEmoji emojiId={emoji._id} name={emoji.name} size="lg" />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>:{emoji.name}:</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Button
                    type="button"
                    variant="destructive"
                    size="icon-sm"
                    title={t('delete')}
                    aria-label={t('delete')}
                    onClick={() => setEmojiPendingDeletion(emoji)}
                  >
                    <Trash2Icon />
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        )}
      </SettingsBlock>
      <Dialog
        open={emojiPendingDeletion !== null}
        onOpenChange={(open) => {
          if (!open && !emojiDeleting) {
            setEmojiPendingDeletion(null)
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('deleteTitle', { name: emojiPendingDeletion?.name ?? '' })}
            </DialogTitle>
            <DialogDescription>{t('deleteDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={emojiDeleting}
              onClick={() => setEmojiPendingDeletion(null)}
            >
              {t('cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={emojiDeleting}
              onClick={() => void handleEmojiDelete()}
            >
              {t('deleteEmoji')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
    case 'engagement':
      return <ServerSettingsEngagementPanel serverId={serverId} />
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
