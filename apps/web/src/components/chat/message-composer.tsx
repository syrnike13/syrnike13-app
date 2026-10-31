import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react'
import { randomUuid } from '#/lib/random-uuid'
import type { Message } from '@syrnike13/api-types'
import { useLocale, useTranslations, type Translator } from '@syrnike13/ui/i18n'
import { useQuery } from '@tanstack/react-query'
import { Effect } from 'effect'
import { ArrowUpIcon, PlusIcon, XIcon } from '#/components/icons'

import { ComposerAttachmentStrip } from '#/components/chat/composer-attachment-strip'
import { ComposerEditor, type ComposerEditorHandle } from '#/components/chat/composer-editor'
import { ComposerEmojiPicker } from '#/components/chat/composer-emoji-picker'
import { ComposerReplyBanner } from '#/components/chat/message-reply-preview'
import { Button } from '@syrnike13/ui/primitives/button'
import { Spinner } from '@syrnike13/ui/primitives/spinner'
import type { SendMessageInput } from '@syrnike13/client/api/messages-api'
import type { Channel, User } from '@syrnike13/api-types'
import {
  memberDisplayColour,
  normalizeRoleColour,
} from '#/features/sync/member-list-groups'
import { getMentionableUsers } from '#/lib/mentions'
import { isCustomEmojiId } from '#/lib/emoji'
import { loadEmojiCatalog, searchEmoji } from '#/lib/emoji-catalog'
import {
  MAX_MENTION_SUGGESTION_ITEMS,
  type MentionSuggestionItem,
} from '#/lib/message-format/extensions/mention-suggestion'
import { memberRoleEntries } from '@syrnike13/client/sync/selectors'
import { useSyncStore } from '@syrnike13/client/sync/sync-store'
import { useAuth } from '#/features/auth/auth-context'
import { getChannelLabel } from '@syrnike13/client/sync/channel-label'
import {
  isServerVoiceChannel,
  runtimeChannelName,
  serverChannelServerId,
} from '@syrnike13/client/lib/channel-voice'
import { FloatingBarShell } from '#/components/layout/floating-bar-shell'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@syrnike13/ui/primitives/tooltip'
import { cn } from '#/lib/utils'
import { ChannelPermission } from '#/features/authorization/authorization'
import { hasPermissionBit } from '@syrnike13/client/lib/permission-bits'
import { useComposerState } from '#/features/chat/use-composer-state'
import { useComposerAttachments } from '#/features/chat/use-composer-attachments'

function composerPlaceholder(
  channel: Channel | undefined,
  users: Record<string, User>,
  currentUserId: string | undefined,
  isEditing: boolean,
  waitingForConnection: boolean,
  t: Translator,
  tChat: Translator,
) {
  if (waitingForConnection) return t('waitingConnection')
  if (isEditing) return t('newText')
  if (!channel) return t('writeMessage')
  if (channel.channel_type === 'TextChannel') {
    return t('messageIn', { name: channel.name })
  }
  if (isServerVoiceChannel(channel)) {
    const name = runtimeChannelName(channel) || t('voiceChannel')
    return t('messageIn', { name })
  }
  const label = getChannelLabel(channel, users, currentUserId, tChat)
  return t('messageTo', { label })
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
  /** Стрелка вверх в пустом поле: редактировать последнее своё сообщение. */
  onEditLast?: () => boolean
  onSend: (input: SendMessageInput) => Promise<void>
  onEdit?: (messageId: string, content: string) => Promise<void>
  onTyping?: () => void
  onStopTyping?: () => void
  /** Плавает над лентой (как UserPanel). */
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
  onEditLast,
  onSend,
  onEdit,
  onTyping,
  onStopTyping,
  onHeightChange,
}: MessageComposerProps) {
  const t = useTranslations('chat.composer')
  const tChat = useTranslations('chat')
  const auth = useAuth()
  const members = useSyncStore((s) => s.members)
  const composerRef = useRef<ComposerEditorHandle>(null)
  const composerInputRowRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
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
    toggleSpoiler: togglePendingSpoiler,
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
  const hasDraft = value.trim().length > 0 || files.length > 0
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
              description: t('notifyEveryone'),
            })
          }
          if ('online'.startsWith(q)) {
            matchingItems.push({
              kind: 'online',
              label: '@online',
              description: t('notifyOnline'),
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
              description: t('notifyRole'),
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
      t,
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
            description: t('mentionChannel'),
          }))
      },
    [channels, serverId, t],
  )

  const { locale } = useLocale()
  const emojiCatalog = useQuery({
    queryKey: ['emoji-catalog', locale],
    queryFn: () => loadEmojiCatalog(locale),
    staleTime: Infinity,
  }).data
  const servers = useSyncStore((s) => s.servers)
  const customEmojis = useSyncStore((s) => s.emojis)
  /** Emoji of every joined server, the current one first. */
  const usableCustomEmojis = useMemo(
    () =>
      Object.values(customEmojis)
        .filter(
          (emoji) => emoji.parent.type === 'Server' && servers[emoji.parent.id],
        )
        .map((emoji) => ({
          id: emoji._id,
          name: emoji.name,
          serverId: emoji.parent.type === 'Server' ? emoji.parent.id : undefined,
        }))
        .sort((a, b) =>
          a.serverId === serverId ? -1 : b.serverId === serverId ? 1 : 0,
        ),
    [customEmojis, serverId, servers],
  )

  const buildEmojiItems = useMemo(
    () =>
      (query: string): MentionSuggestionItem[] =>
        searchEmoji(emojiCatalog, usableCustomEmojis, query, 10).map((match) =>
          match.kind === 'custom'
            ? { kind: 'emoji', label: `:${match.name}:`, customId: match.id }
            : {
                kind: 'emoji',
                label: `:${match.emoji.shortcode}:`,
                unicode: match.emoji.unicode,
              },
        ),
    [emojiCatalog, usableCustomEmojis],
  )

  const resolveEmoji = useMemo(
    () => (name: string) => {
      const custom = usableCustomEmojis.find(
        (emoji) => emoji.name.toLowerCase() === name,
      )
      if (custom) return { customId: custom.id }
      const unicode = emojiCatalog?.byShortcode.get(name)
      return unicode ? { unicode: unicode.unicode } : null
    },
    [emojiCatalog, usableCustomEmojis],
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
      return
    }

    if (isEditing && editingMessage) {
      if (!content) {
        return
      }
      if (!onEdit) return

      setSending(true)
      try {
        await Effect.runPromise(
          Effect.tryPromise({
            try: () => onEdit(editingMessage._id, content),
            catch: (cause) => cause,
          }),
        )
        onCancelAction?.()
      } catch (error) {
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
      const currentAttempt = sendAttemptRef.current
      const sendAttempt =
        currentAttempt?.signature === signature
          ? currentAttempt
          : { signature, nonce: randomUuid() }
      sendAttemptRef.current = sendAttempt
      await Effect.runPromise(
        Effect.gen(function*() {
          const attachments = yield* uploadAttachments(token)
          yield* Effect.tryPromise({
            try: () =>
              onSend({
                nonce: sendAttempt.nonce,
                content: content || undefined,
                attachments: attachments.length ? attachments : undefined,
                replies: replyTo
                  ? [{ id: replyTo._id, mention: replyMention }]
                  : undefined,
              }),
            catch: (cause) => cause,
          })
          yield* Effect.sync(() => {
            onStopTyping?.()
            if (
              !bypassesSlowmode &&
              channel?.channel_type === 'TextChannel'
            ) {
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
          })
        }),
      )
    } catch (error) {
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
      ? t('slowmodeWait', { seconds: slowmodeRemaining })
      : !canSendMessages
      ? t('noPermission')
      : composerPlaceholder(
          channel,
          users,
          auth.user?._id,
          isEditing,
          waitingForConnection,
          t,
          tChat,
        ))

  const showComposerDivider = showReplyBanner || isEditing

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
        <div className="flex h-8 shrink-0 items-center justify-between gap-2 px-3 text-sm text-muted-foreground">
          <span>{t('editing')}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={onCancelAction}
            aria-label={t('cancelEdit')}
          >
            <XIcon />
          </Button>
        </div>
      ) : null}

      <ComposerAttachmentStrip
        files={files}
        sending={sending}
        onRemove={removeFile}
        onToggleSpoiler={togglePendingSpoiler}
      />

      <div
        ref={composerInputRowRef}
        className={cn(
          'flex min-h-14 items-end gap-3 px-3',
          showComposerDivider && 'border-t border-border',
        )}
      >
        {!isEditing ? (
          <div className="mb-3 flex shrink-0">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              disabled={composerDisabled || sending || !canUploadFiles}
              onChange={handleFilesSelected}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-muted-foreground"
              title={t('attachment')}
              aria-label={t('attachment')}
              disabled={composerDisabled || sending || !canUploadFiles}
              onClick={() => fileInputRef.current?.click()}
            >
              <PlusIcon className="size-5" />
            </Button>
          </div>
        ) : null}

        <ComposerEditor
          ref={composerRef}
          value={value}
          disabled={composerDisabled || sending}
          placeholder={placeholder}
          formatContext={formatContext}
          mentionItems={buildMentionItems}
          channelItems={buildChannelItems}
          emojiItems={buildEmojiItems}
          resolveEmoji={resolveEmoji}
          menuAnchorRef={composerInputRowRef}
          menuSurfaceClassName="bg-secondary text-secondary-foreground"
          className="min-h-14 min-w-0 flex-1"
          editorClassName="min-h-14 px-0 py-4.25 leading-5.5"
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
            if (event.key === 'ArrowUp') {
              if (!isEditing && files.length === 0 && onEditLast?.()) {
                event.preventDefault()
              }
              return
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              void submit()
            }
          }}
        />

        <div className="mb-3 flex shrink-0 items-center gap-1 text-muted-foreground">
          {!isEditing ? (
            <ComposerEmojiPicker
              serverId={serverId}
              disabled={composerDisabled || sending}
              onInsert={insertAtCaret}
            />
          ) : null}
          {sending ? (
            <span role="status" aria-label={t('sending')} className="flex size-8 items-center justify-center">
              <Spinner className="size-5 motion-reduce:animate-none" />
            </span>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={composerDisabled || !hasDraft}
                    onClick={() => void submit()}
                    aria-label={t('send')}
                  />
                }
              >
                <ArrowUpIcon className="size-5" />
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={8}>
                {t('send')}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </>
  )

  const composerBody = (
    <div
      ref={composerBodyRef}
      className="pointer-events-auto relative flex flex-col gap-2"
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
          {t('dropFiles')}
        </p>
      ) : null}

      <FloatingBarShell
        data-composer-chrome
        className={cn(
          dragActive && 'ring-2 ring-primary/40',
          composerDisabled && 'opacity-60',
        )}
        surfaceClassName="flex flex-col transition-colors"
      >
        {composerChrome}
      </FloatingBarShell>
    </div>
  )

  return <TooltipProvider delay={300}>{composerBody}</TooltipProvider>
}
