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
import { uploadAttachment } from '#/features/api/media-api'
import type { Channel, User } from '@syrnike13/api-types'
import { memberDisplayColour } from '#/features/sync/member-list-groups'
import { getMentionableUsers } from '#/lib/mentions'
import { isCustomEmojiId } from '#/lib/emoji'
import type { MentionSuggestionItem } from '#/lib/message-format/extensions/mention-suggestion'
import { memberRoleEntries } from '#/features/sync/selectors'
import { useSyncStore } from '#/features/sync/sync-store'
import { useAuth } from '#/features/auth/auth-context'
import {
  createPendingFiles,
  revokePendingFiles,
  type PendingComposerFile,
} from '#/lib/composer-files'
import { getChannelLabel } from '#/features/sync/channel-label'
import {
  isServerVoiceChannel,
  runtimeChannelName,
  serverChannelServerId,
} from '#/lib/channel-voice'
import { FloatingBarShell } from '#/components/layout/floating-bar-shell'
import { cn } from '#/lib/utils'

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
  /** Плавает над лентой (как UserPanel). */
  floating?: boolean
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
  floating = false,
}: MessageComposerProps) {
  const auth = useAuth()
  const members = useSyncStore((s) => s.members)
  const composerRef = useRef<ComposerEditorHandle>(null)
  const composerInputRowRef = useRef<HTMLDivElement>(null)

  const [value, setValue] = useState('')
  const [files, setFiles] = useState<PendingComposerFile[]>([])
  const [sending, setSending] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [replyMention, setReplyMention] = useState(true)

  const isEditing = Boolean(editingMessage)
  const showReplyBanner = Boolean(replyTo && !isEditing)

  const serverId = serverChannelServerId(channel)
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
    if (editingMessage) {
      setValue(editingMessage.content ?? '')
      setFiles([])
      requestAnimationFrame(() => composerRef.current?.focus())
      return
    }
    if (!replyTo) {
      setValue('')
      return
    }
    setReplyMention(true)
    requestAnimationFrame(() => composerRef.current?.focus())
  }, [editingMessage?._id, replyTo?._id])

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
        const items: MentionSuggestionItem[] = []
        const isTextChannel = channel?.channel_type === 'TextChannel'

        if (isTextChannel) {
          if (!q || 'everyone'.startsWith(q)) {
            items.push({
              kind: 'everyone',
              label: '@everyone',
              description: 'все в канале',
            })
          }
          if (!q || 'online'.startsWith(q)) {
            items.push({
              kind: 'online',
              label: '@online',
              description: 'кто в сети',
            })
          }
        }

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

        for (const user of filteredUsers) {
          const member =
            serverId && members[`${serverId}:${user._id}`]
              ? members[`${serverId}:${user._id}`]
              : undefined
          const serverName =
            member?.nickname?.trim() || user.display_name || user.username

          items.push({
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

        return items
      },
    [channel?.channel_type, members, mentionable, server, serverId],
  )

  function appendFiles(fileList: FileList | File[]) {
    if (isEditing) return
    const next = createPendingFiles(fileList)
    if (next.length === 0) return
    setFiles((current) => [...current, ...next])
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
    if (disabled || sending || isEditing) return
    if (event.dataTransfer.files.length > 0) {
      appendFiles(event.dataTransfer.files)
    }
  }

  function removeFile(id: string) {
    setFiles((current) => {
      const target = current.find((file) => file.id === id)
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl)
      }
      return current.filter((file) => file.id !== id)
    })
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
    if ((!content && files.length === 0 && !isEditing) || sending || disabled) {
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
        setValue('')
        composerRef.current?.clear()
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
      const attachments: string[] = []

      for (const pending of files) {
        const id = await uploadAttachment(token, pending.file)
        attachments.push(id)
      }

      await onSend({
        content: content || undefined,
        attachments: attachments.length ? attachments : undefined,
        replies: replyTo
          ? [{ id: replyTo._id, mention: replyMention }]
          : undefined,
      })

      setValue('')
      composerRef.current?.clear()
      revokePendingFiles(files)
      setFiles([])
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
    composerPlaceholder(
      channel,
      users,
      auth.user?._id,
      isEditing,
      waitingForConnection,
    )

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
              (disabled || sending) && 'pointer-events-none',
            )}
            title="Вложение"
          >
            <input
              type="file"
              multiple
              className="sr-only"
              disabled={disabled || sending}
              onChange={handleFilesSelected}
            />
            <PlusIcon className="size-5" />
          </label>
        ) : null}

        <ComposerEditor
          ref={composerRef}
          value={value}
          disabled={disabled || sending}
          placeholder={placeholder}
          formatContext={formatContext}
          mentionItems={buildMentionItems}
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
              disabled={disabled || sending}
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
              aria-hidden
            >
              <Loader2Icon className="size-4 animate-spin" />
            </span>
          ) : null}
        </div>
      </div>
    </>
  )

  const composerBody = (
    <div
      className={cn(
        'relative flex flex-col',
        floating
          ? 'pointer-events-auto gap-2'
          : 'gap-2 border-t border-border bg-card p-3 text-card-foreground',
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
        <div className="flex flex-wrap gap-2">
          {files.map((pending) => (
            <div
              key={pending.id}
              className="relative flex items-center gap-2 rounded-md border border-border bg-secondary px-2 py-1 text-xs text-secondary-foreground"
            >
              {pending.previewUrl ? (
                <FxImage
                  src={pending.previewUrl}
                  rounded="md"
                  wrapperClassName="size-10 shrink-0"
                  className="size-10"
                />
              ) : (
                <span className="max-w-32 truncate">{pending.file.name}</span>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={() => removeFile(pending.id)}
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
            (disabled || sending) && 'opacity-60',
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
            (disabled || sending) && 'opacity-60',
          )}
        >
          {composerChrome}
        </div>
      )}
    </div>
  )

  return composerBody
}
