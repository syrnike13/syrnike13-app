import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react'
import type { Message } from '@syrnike13/api-types'
import { Loader2Icon, PlusIcon, XIcon } from '#/components/icons'
import { toast } from 'sonner'

import { ComposerEditor, type ComposerEditorHandle } from '#/components/chat/composer-editor'
import { ComposerEmojiPicker } from '#/components/chat/composer-emoji-picker'
import { ComposerReplyBanner } from '#/components/chat/message-reply-preview'
import { FxImage } from '#/components/ui/fx-image'
import { Button } from '#/components/ui/button'
import type { SendMessageInput } from '#/features/api/messages-api'
import type { Channel, User } from '@syrnike13/api-types'
import {
  memberDisplayColour,
  normalizeRoleColour,
} from '#/features/sync/member-list-groups'
import { getMentionableUsers } from '#/lib/mentions'
import { isCustomEmojiId } from '#/lib/emoji'
import {
  MAX_MENTION_SUGGESTION_ITEMS,
  type MentionSuggestionItem,
} from '#/lib/message-format/extensions/mention-suggestion'
import { memberRoleEntries } from '#/features/sync/selectors'
import { useSyncStore } from '#/features/sync/sync-store'
import { useAuth } from '#/features/auth/auth-context'
import { getChannelLabel } from '#/features/sync/channel-label'
import {
  isServerVoiceChannel,
  runtimeChannelName,
  serverChannelServerId,
} from '#/lib/channel-voice'
import { FloatingBarShell } from '#/components/layout/floating-bar-shell'
import { cn } from '#/lib/utils'
import { ChannelPermission } from '#/features/authorization/authorization'
import { hasPermissionBit } from '#/lib/permission-bits'
import { useComposerState } from '#/features/chat/use-composer-state'
import { useComposerAttachments } from '#/features/chat/use-composer-attachments'

const composerIconClass =
  'flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50'

const composerIconHoverClass = (floating: boolean) =>
  floating ? 'hover:bg-muted' : 'hover:bg-secondary'

function composerPlaceholder(
  channel: Channel | undefined,
  users: Record<string, User>,
  currentUserId: string | undefined,
  isEditing: boolean,
  waitingForConnection: boolean,
) {
  if (waitingForConnection) return 'Ожидание соединения…'
  if (isEditing) return 'Новый текст сообщения…'
  if (!channel) return 'Написать сообщение…'
  if (channel.channel_type === 'TextChannel') {
    return `Сообщение #${channel.name}`
  }
  if (isServerVoiceChannel(channel)) {
    const name = runtimeChannelName(channel) || 'голосовой'
    return `Сообщение #${name}`
  }
  const label = getChannelLabel(channel, users, currentUserId)
  return `Сообщение — ${label}`
}

type MessageComposerProps = {
  channel?: Channel
  disabled?: boolean
  disabledPlaceholder?: string
  token?: string
  users: Record<string, User>
  replyTo?: Message | null
  editingMessage?: Message | null
  onCancelAction?: () => void
  onSend: (input: SendMessageInput) => Promise<void>
  onEdit?: (messageId: string, content: string) => Promise<void>
  onTyping?: () => void
  onStopTyping?: () => void
  /** Плавает над лентой (как UserPanel). */
  floating?: boolean
  onHeightChange?: (height: number) => void
}

const RESERVED_NON_PARTICIPANT_SLOTS = 2

function limitMentionSuggestionGroups(
  participants: MentionSuggestionItem[],
  otherItems: MentionSuggestionItem[],
): MentionSuggestionItem[] {
  if (otherItems.length === 0) {
    return participants.slice(0, MAX_MENTION_SUGGESTION_ITEMS)
  }
  if (participants.length === 0) {
    return otherItems.slice(0, MAX_MENTION_SUGGESTION_ITEMS)
  }

  const reservedOtherSlots = Math.min(
    RESERVED_NON_PARTICIPANT_SLOTS,
    otherItems.length,
  )
  const visibleParticipants = participants.slice(
    0,
    MAX_MENTION_SUGGESTION_ITEMS - reservedOtherSlots,
  )
  const remainingSlots =
    MAX_MENTION_SUGGESTION_ITEMS - visibleParticipants.length

  return [...visibleParticipants, ...otherItems.slice(0, remainingSlots)]
}

export function MessageComposer({
  channel,
  disabled,
  disabledPlaceholder,
  token,
  users,
  replyTo,
  editingMessage,
  onCancelAction,
  onSend,
  onEdit,
  onTyping,
  onStopTyping,
  floating = false,
  onHeightChange,
}: MessageComposerProps) {
  const auth = useAuth()
  const members = useSyncStore((s) => s.members)
  const composerRef = useRef<ComposerEditorHandle>(null)
  const composerInputRowRef = useRef<HTMLDivElement>(null)
  const composerBodyRef = useRef<HTMLDivElement>(null)
  const sendAttemptRef = useRef<{ signature: string; nonce: string } | null>(null)

  const channelId = channel?._id
  const draftOwnerId = auth.user?._id
  const {
    value,
    editing: isEditing,
    setValue,
    clearCompose,
  } = useComposerState({
    userId: draftOwnerId,
    channelId,
    editingMessage,
  })
  const {
    files,
    append: appendPendingFiles,
    remove: removePendingFile,
    reset: resetAttachments,
    uploadAll: uploadAttachments,
  } = useComposerAttachments(channelId)
  const [sending, setSending] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [replyMention, setReplyMention] = useState(true)
  const [slowmodeEndsAt, setSlowmodeEndsAt] = useState(0)
  const [now, setNow] = useState(Date.now())

  const showReplyBanner = Boolean(replyTo && !isEditing)

  const serverId = serverChannelServerId(channel)
  const channelPermissions = useSyncStore((s) =>
    channelId ? (s.authorization.channels[channelId] ?? 0) : 0,
  )
  const canSendMessages =
    !serverId || hasPermissionBit(channelPermissions, ChannelPermission.SendMessage)
  const canUploadFiles =
    !serverId || hasPermissionBit(channelPermissions, ChannelPermission.UploadFiles)
  const canMassMention =
    !serverId ||
    hasPermissionBit(channelPermissions, ChannelPermission.MentionEveryone)
  const canMentionRoles =
    !serverId ||
    hasPermissionBit(channelPermissions, ChannelPermission.MentionRoles)
  const bypassesSlowmode =
    !serverId ||
    hasPermissionBit(channelPermissions, ChannelPermission.BypassSlowmode)
  const slowmodeRemaining = bypassesSlowmode
    ? 0
    : Math.max(0, Math.ceil((slowmodeEndsAt - now) / 1_000))
  const slowmodeActive = !isEditing && slowmodeRemaining > 0
  const composerDisabled = disabled || !canSendMessages || slowmodeActive
  const server = useSyncStore((s) =>
    serverId ? s.servers[serverId] : undefined,
  )
  const channels = useSyncStore((s) => s.channels)
  const emojis = useSyncStore((s) => s.emojis)
  const replyMember = useSyncStore((s) =>
    replyTo && serverId
      ? s.members[`${serverId}:${replyTo.author}`]
      : undefined,
  )

  const replyAuthorColor = useMemo(() => {
    if (!server || !replyMember) return undefined
    for (const role of memberRoleEntries(server, replyMember)) {
      if (!role.colour) continue
      const colour = role.colour.trim()
      return colour.startsWith('#') ? colour : `#${colour}`
    }
    return undefined
  }, [replyMember, server])

  useEffect(() => {
    setDragActive(false)
    setSlowmodeEndsAt(0)
    setNow(Date.now())
  }, [channelId])

  useEffect(() => {
    if (slowmodeEndsAt <= Date.now()) return
    const interval = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(interval)
  }, [slowmodeEndsAt])

  useEffect(() => {
    const element = composerBodyRef.current
    if (!element || !onHeightChange) return

    const update = () => onHeightChange(Math.ceil(element.getBoundingClientRect().height))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [onHeightChange])

  useEffect(() => {
    if (!editingMessage) return
    requestAnimationFrame(() => composerRef.current?.focus())
  }, [editingMessage?._id])

  useEffect(() => {
    if (!replyTo) return
    setReplyMention(true)
    requestAnimationFrame(() => composerRef.current?.focus())
  }, [replyTo?._id])

  const mentionable = useMemo(
    () => getMentionableUsers(channel, users, members, auth.user?._id),
    [auth.user?._id, channel, members, users],
  )

  const formatContext = useMemo(
    () => ({
      users,
      members,
      emojis,
      roles: server?.roles,
      channels,
      server,
      serverId,
      currentUserId: auth.user?._id,
    }),
    [
      auth.user?._id,
      channels,
      emojis,
      members,
      server,
      serverId,
      users,
    ],
  )

  const buildMentionItems = useMemo(
    () =>
      (query: string): MentionSuggestionItem[] => {
        const q = query.toLowerCase()
        const isTextChannel = channel?.channel_type === 'TextChannel'

        const filteredUsers = q
          ? mentionable
              .filter((user) => {
                const member = serverId
                  ? members[`${serverId}:${user._id}`]
                  : undefined
                const serverName =
                  member?.nickname?.trim() ||
                  user.display_name ||
                  user.username
                return (
                  user.username.toLowerCase().includes(q) ||
                  user.display_name?.toLowerCase().includes(q) ||
                  serverName.toLowerCase().includes(q)
                )
              })
              .slice(0, 8)
          : mentionable.slice(0, 8)

        const participantItems: MentionSuggestionItem[] = []
        for (const user of filteredUsers) {
          const member =
            serverId && members[`${serverId}:${user._id}`]
              ? members[`${serverId}:${user._id}`]
              : undefined
          const serverName =
            member?.nickname?.trim() || user.display_name || user.username

          participantItems.push({
            kind: 'user',
            id: user._id,
            user,
            serverName,
            username: user.username,
            nameColour:
              server && member
                ? memberDisplayColour(server, member)
                : undefined,
          })
        }

        if (!q) {
          return participantItems.slice(0, MAX_MENTION_SUGGESTION_ITEMS)
        }

        const matchingItems: MentionSuggestionItem[] = []
        if (isTextChannel && canMassMention) {
          if ('everyone'.startsWith(q)) {
            matchingItems.push({
              kind: 'everyone',
              label: '@everyone',
              description: 'Оповестить всех участников канала',
            })
          }
          if ('online'.startsWith(q)) {
            matchingItems.push({
              kind: 'online',
              label: '@online',
              description: 'Оповестить участников в сети',
            })
          }
        }

        if (isTextChannel && server?.roles) {
          for (const role of Object.values(server.roles)
            .filter(
              (role) =>
                (role.mentionable || canMentionRoles) &&
                role.name.toLowerCase().includes(q),
            )
            .slice(0, 5)) {
            matchingItems.push({
              kind: 'role',
              id: role._id,
              label: `@${role.name}`,
              description: 'Оповестить участников с этой ролью',
              colour: role.colour
                ? normalizeRoleColour(role.colour)
                : undefined,
            })
          }
        }

        return limitMentionSuggestionGroups(participantItems, matchingItems)
      },
    [
      canMassMention,
      canMentionRoles,
      channel?.channel_type,
      members,
      mentionable,
      server,
      serverId,
    ],
  )

  const buildChannelItems = useMemo(
    () =>
      (query: string): MentionSuggestionItem[] => {
        if (!serverId) return []
        const q = query.toLowerCase()
        return Object.values(channels)
          .filter(
            (candidate): candidate is Extract<
              Channel,
              { channel_type: 'TextChannel' }
            > =>
              candidate.channel_type === 'TextChannel' &&
              candidate.server === serverId &&
              (!q || candidate.name.toLowerCase().includes(q)),
          )
          .slice(0, 8)
          .map((candidate) => ({
            kind: 'channel' as const,
            id: candidate._id,
            label: `#${candidate.name}`,
            description: 'Упомянуть текстовый канал',
          }))
      },
    [channels, serverId],
  )

  function appendFiles(fileList: FileList | File[]) {
    if (isEditing || !canUploadFiles) return
    appendPendingFiles(fileList)
  }

  function handleFilesSelected(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files
    if (!selected) return
    appendFiles(selected)
    event.target.value = ''
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault()
    setDragActive(false)
    if (composerDisabled || sending || isEditing || !canUploadFiles) return
    if (event.dataTransfer.files.length > 0) {
      appendFiles(event.dataTransfer.files)
    }
  }

  function removeFile(id: string) {
    removePendingFile(id)
  }

  function insertAtCaret(text: string) {
    const customMatch = text.match(/^:([0-9A-Z]{26}):$/i)
    if (customMatch && isCustomEmojiId(customMatch[1]!)) {
      composerRef.current?.insertCustomEmoji(customMatch[1]!)
      return
    }
    composerRef.current?.insertText(text)
  }

  function buildOutboundContent(raw: string) {
    const trimmed = raw.trim()
    if (!replyTo || !replyMention || isEditing) return trimmed

    const mention = `<@${replyTo.author}>`
    if (!trimmed.includes(mention)) {
      return trimmed ? `${mention} ${trimmed}` : mention
    }
    return trimmed
  }

  async function submit() {
    const content = buildOutboundContent(value)
    if (
      (!content && files.length === 0 && !isEditing) ||
      sending ||
      composerDisabled
    ) {
      return
    }

    if (!token) {
      toast.error('Нет сессии')
      return
    }

    if (isEditing && editingMessage) {
      if (!content) {
        toast.error('Сообщение не может быть пустым')
        return
      }
      if (!onEdit) return

      setSending(true)
      try {
        await onEdit(editingMessage._id, content)
        onCancelAction?.()
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : 'Не удалось изменить',
        )
      } finally {
        setSending(false)
        requestAnimationFrame(() => composerRef.current?.focus())
      }
      return
    }

    setSending(true)
    try {
      const signature = JSON.stringify({
        channelId,
        content,
        files: files.map((file) => file.id),
        replyId: replyTo?._id,
        replyMention,
      })
      if (sendAttemptRef.current?.signature !== signature) {
        sendAttemptRef.current = { signature, nonce: crypto.randomUUID() }
      }
      const attachments = await uploadAttachments(token)

      await onSend({
        nonce: sendAttemptRef.current.nonce,
        content: content || undefined,
        attachments: attachments.length ? attachments : undefined,
        replies: replyTo
          ? [{ id: replyTo._id, mention: replyMention }]
          : undefined,
      })
      onStopTyping?.()
      if (!bypassesSlowmode && channel?.channel_type === 'TextChannel') {
        const delay = channel.slowmode ?? 0
        if (delay > 0) {
          const endsAt = Date.now() + delay * 1_000
          setNow(Date.now())
          setSlowmodeEndsAt(endsAt)
        }
      }

      clearCompose()
      composerRef.current?.clear()
      resetAttachments()
      sendAttemptRef.current = null
      onCancelAction?.()
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось отправить',
      )
    } finally {
      setSending(false)
      requestAnimationFrame(() => composerRef.current?.focus())
    }
  }

  const waitingForConnection =
    Boolean(token) && auth.gatewayState !== 'connected'

  const placeholder =
    disabledPlaceholder ??
    (slowmodeActive
      ? `Можно отправить через ${slowmodeRemaining} с`
      : !canSendMessages
      ? 'У вас нет права отправлять сообщения'
      : composerPlaceholder(
          channel,
          users,
          auth.user?._id,
          isEditing,
          waitingForConnection,
        ))

  const hasComposerHeader = showReplyBanner || isEditing

  const composerChrome = (
    <>
      {showReplyBanner && replyTo ? (
        <ComposerReplyBanner
          message={replyTo}
          users={users}
          authorColor={replyAuthorColor}
          mentionEnabled={replyMention}
          onMentionToggle={setReplyMention}
          onClear={() => onCancelAction?.()}
        />
      ) : null}

      {isEditing && editingMessage ? (
        <div className="flex h-8 shrink-0 items-center justify-between gap-2 px-3 text-[13px] text-muted-foreground">
          <span>Редактирование сообщения</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 shrink-0 rounded-full hover:bg-foreground/10"
            onClick={onCancelAction}
            aria-label="Отменить редактирование"
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      ) : null}

      <div
        ref={composerInputRowRef}
        className={cn(
          'flex items-end gap-0.5 px-1 pb-2',
          floating && 'min-h-14',
          !floating && hasComposerHeader && 'min-h-14',
          !floating && !hasComposerHeader && 'min-h-11',
          hasComposerHeader && 'border-t border-foreground/10',
        )}
      >
        {!isEditing ? (
          <label
            className={cn(
              composerIconClass,
              composerIconHoverClass(floating),
              'mb-1 cursor-pointer',
              (composerDisabled || sending || !canUploadFiles) &&
                'pointer-events-none',
            )}
            title="Вложение"
          >
            <input
              type="file"
              multiple
              className="sr-only"
              disabled={composerDisabled || sending || !canUploadFiles}
              onChange={handleFilesSelected}
            />
            <PlusIcon className="size-5" />
          </label>
        ) : null}

        <ComposerEditor
          ref={composerRef}
          value={value}
          disabled={composerDisabled || sending}
          placeholder={placeholder}
          formatContext={formatContext}
          mentionItems={buildMentionItems}
          channelItems={buildChannelItems}
          menuAnchorRef={composerInputRowRef}
          menuSurfaceClassName={
            floating
              ? 'bg-secondary text-secondary-foreground'
              : 'bg-accent text-foreground'
          }
          className="min-w-0 flex-1"
          editorClassName={
            floating ? 'text-secondary-foreground' : 'text-foreground'
          }
          onValueChange={(nextValue) => {
            if (nextValue !== value) {
              onTyping?.()
            }
            setValue(nextValue)
          }}
          onPasteFiles={
            !isEditing
              ? (fileList) => {
                  appendFiles(fileList)
                }
              : undefined
          }
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              onCancelAction?.()
              return
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              void submit()
            }
          }}
        />

        <div className="mb-1 flex shrink-0 items-center">
          {!isEditing ? (
            <ComposerEmojiPicker
              serverId={serverId}
              disabled={composerDisabled || sending}
              onInsert={insertAtCaret}
              triggerClassName={cn(
                composerIconClass,
                composerIconHoverClass(floating),
              )}
            />
          ) : null}
          {sending ? (
            <span
              className={cn(
                composerIconClass,
                composerIconHoverClass(floating),
                'pointer-events-none',
              )}
              role="status"
              aria-label="Отправка сообщения"
            >
              <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />
            </span>
          ) : null}
        </div>
      </div>
    </>
  )

  const composerBody = (
    <div
      ref={composerBodyRef}
      className={cn(
        'relative flex flex-col',
        floating
          ? 'pointer-events-auto gap-2'
          : 'gradient-surface-raised gap-2 border-t border-border bg-card p-3 text-card-foreground',
      )}
      onDragEnter={(event) => {
        event.preventDefault()
        if (!isEditing) setDragActive(true)
      }}
      onDragOver={(event) => {
        event.preventDefault()
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return
        setDragActive(false)
      }}
      onDrop={handleDrop}
    >
      {dragActive ? (
        <p className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md bg-card/90 text-sm font-medium text-primary">
          Отпустите файлы для вложения
        </p>
      ) : null}
      {files.length > 0 ? (
        <div className="flex flex-wrap gap-2" aria-label="Вложения">
          {files.map((pending) => (
            <div
              key={pending.id}
              className="relative flex items-center gap-2 rounded-md border border-border bg-secondary px-2 py-1 text-xs text-secondary-foreground"
            >
              <div className="min-w-0">
                {pending.previewUrl ? (
                  <FxImage
                    src={pending.previewUrl}
                    rounded="md"
                    wrapperClassName="size-10 shrink-0"
                    className="size-10"
                  />
                ) : (
                  <span className="block max-w-32 truncate">
                    {pending.file.name}
                  </span>
                )}
                {pending.status === 'uploading' ? (
                  <span className="mt-1 block h-1 w-10 overflow-hidden rounded-full bg-muted" aria-label={`Загружено ${Math.round((pending.progress ?? 0) * 100)}%`}>
                    <span
                      className="block h-full bg-primary transition-[width] duration-150 motion-reduce:transition-none"
                      style={{ width: `${Math.round((pending.progress ?? 0) * 100)}%` }}
                    />
                  </span>
                ) : null}
                {pending.status === 'error' ? (
                  <span className="block max-w-32 truncate text-destructive">
                    {pending.error}
                  </span>
                ) : null}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6"
                disabled={sending && pending.status !== 'uploading'}
                onClick={() => removeFile(pending.id)}
                aria-label={`Удалить вложение ${pending.file.name}`}
              >
                <XIcon className="size-3" />
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {floating ? (
        <FloatingBarShell
          data-composer-chrome
          className={cn(
            dragActive && 'ring-2 ring-primary/40',
            (composerDisabled || sending) && 'opacity-60',
          )}
          surfaceClassName="flex flex-col transition-colors"
        >
          {composerChrome}
        </FloatingBarShell>
      ) : (
        <div
          data-composer-chrome
          className={cn(
            'flex flex-col transition-colors',
            hasComposerHeader
              ? 'overflow-hidden rounded-lg border border-border bg-accent text-foreground'
              : 'min-h-11 rounded-lg border border-border bg-accent py-1 text-foreground',
            dragActive && 'ring-2 ring-primary/40',
            (composerDisabled || sending) && 'opacity-60',
          )}
        >
          {composerChrome}
        </div>
      )}
    </div>
  )

  return composerBody
}
