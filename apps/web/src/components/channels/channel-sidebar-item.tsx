import { Link, useMatch, useNavigate, useRouterState } from '@tanstack/react-router'
import {
  CheckCheckIcon,
  HashIcon,
  HeadphonesIcon,
  LinkIcon,
  MessageSquareIcon,
  SettingsIcon,
  Trash2Icon,
  UsersIcon,
} from '#/components/icons'
import { useState, type DragEvent, type MouseEvent } from 'react'
import type { Channel } from '@syrnike13/api-types'
import type { DraggableProvidedDragHandleProps } from '@hello-pangea/dnd'
import { Effect } from 'effect'
import { toast } from 'sonner'

import { RailUnreadIndicator } from '#/components/layout/rail-icon-button'
import { RestrictedTextChannelIcon } from '#/components/icons/restricted-text-channel-icon'
import { VoiceChannelIcon } from '#/components/icons/voice-channel-icon'
import { Button } from '#/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '#/components/ui/context-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { UserAvatar } from '#/components/user/user-avatar'
import { useAuth } from '#/features/auth/auth-context'
import { ackChannelEffect } from '#/features/api/sync-api'
import { editServerMemberEffect } from '#/features/api/servers-api'
import { deleteChannelEffect } from '#/features/api/channels-api'
import { createChannelInviteEffect } from '#/features/api/invites-api'
import { selectChannelNotificationBadge } from '#/features/notifications/notification-selectors'
import type { ChannelUnreadState } from '#/features/sync/types'
import {
  getChannelLabel,
  getDmRecipientId,
} from '#/features/sync/channel-label'
import {
  isIncomingVoiceCall,
  isVoiceCallRingingDismissed,
} from '#/features/sync/voice-call-utils'
import { getChannelLastMessageId, pickDefaultChannelId } from '#/features/sync/selectors'
import {
  syncStore,
  useSyncStore,
} from '#/features/sync/sync-store'
import { VoiceChannelPreview } from '#/components/voice/voice-channel-preview'
import { canJoinVoiceChannel } from '#/features/voice/voice-api-capability'
import { requestVoiceChannelChatOpen } from '#/features/voice/voice-channel-chat-intent'
import { resolveVoiceChannelClickAction } from '#/features/navigation/voice-channel-click'
import { useOptionalMobileVoiceChannelDrawer } from '#/features/navigation/mobile-voice-channel-drawer-context'
import { useVoiceSession } from '#/features/voice/voice-session-context'
import {
  isServerVoiceChannel,
} from '#/lib/channel-voice'
import {
  canManageChannel,
  canMoveServerMember,
} from '#/features/authorization/authorization'
import { isChannelAccessRestricted } from '#/features/authorization/permission-draft'
import {
  readVoiceMemberDragPayload,
  VOICE_MEMBER_DRAG_TYPE,
} from '#/features/voice/voice-member-drag'
import { channelSettingsSearch } from '#/lib/channel-settings-navigation'
import { writeClipboardTextEffect } from '#/lib/clipboard'
import { inviteUrl } from '#/lib/invite-link'
import { attachmentPreviewUrl } from '#/lib/media'
import { publicAppUrl } from '#/lib/public-origin'
import { cn } from '#/lib/utils'

type ChannelSidebarItemProps = {
  channel: Channel
  activeChannelId?: string
  users: Record<string, import('@syrnike13/api-types').User>
  currentUserId?: string
  unreads: Record<string, ChannelUnreadState | undefined>
  canManage?: boolean
  canInvite?: boolean
  dragHandleProps?: DraggableProvidedDragHandleProps
  dragging?: boolean
}

export function ChannelSidebarItem({
  channel,
  activeChannelId,
  users,
  currentUserId,
  unreads: _unreads,
  canManage = false,
  canInvite = false,
  dragHandleProps,
  dragging = false,
}: ChannelSidebarItemProps) {
  const auth = useAuth()
  const voice = useVoiceSession()
  const navigate = useNavigate()
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deletingChannel, setDeletingChannel] = useState(false)
  const [voiceDropActive, setVoiceDropActive] = useState(false)
  const [movingVoiceMember, setMovingVoiceMember] = useState(false)
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const isMobile = pathname.startsWith('/m')
  const channelRoute = isMobile ? '/m/c/$channelId' : '/app/c/$channelId'
  const mobileVoiceChannelDrawer = useOptionalMobileVoiceChannelDrawer()
  const token = auth.session?.token
  const channelRouteMatch = useMatch({
    from: channelRoute,
    shouldThrow: false,
  })
  const server = useSyncStore((s) =>
    channel.channel_type === 'TextChannel' ? s.servers[channel.server] : undefined,
  )
  const member = useSyncStore((s) =>
    channel.channel_type === 'TextChannel' && auth.user?._id
      ? s.members[`${channel.server}:${auth.user._id}`]
      : undefined,
  )
  const canDeleteChannel =
    channel.channel_type === 'TextChannel' &&
    canManageChannel(
      server,
      channel,
      member,
      auth.user?._id,
    )

  function openChannelSettings() {
    const hostChannelId = activeChannelId ?? channel._id
    void navigate({
      to: channelRoute,
      params: { channelId: hostChannelId },
      search: channelSettingsSearch({
        settingsChannel: channel._id,
        settingsTab: 'overview',
        m: channelRouteMatch?.search?.m,
      }),
    })
  }

  async function handleDeleteChannel() {
    if (!token || !canDeleteChannel) return

    setDeletingChannel(true)
    await Effect.runPromise(
      Effect.gen(function*() {
        yield* deleteChannelEffect(token, channel._id)
        yield* Effect.sync(() => {
          syncStore.removeChannel(channel._id)
          toast.success('Канал удалён')
          setDeleteDialogOpen(false)
        })

        const settingsChannelId = channelRouteMatch?.search?.settingsChannel
        const viewingDeletedChannel =
          channelRouteMatch?.params?.channelId === channel._id ||
          settingsChannelId === channel._id

        if (!viewingDeletedChannel) return

        const fallback = pickDefaultChannelId(
          syncStore.getState(),
          auth.user?._id,
        )
        yield* Effect.tryPromise({
          try: () =>
            fallback
              ? navigate({
                  to: channelRoute,
                  params: { channelId: fallback },
                  search: { m: undefined },
                })
              : navigate({
                  to: isMobile ? '/m' : '/app',
                  search: { tab: 'online' },
                }),
          catch: (cause) => cause,
        })
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            toast.error(
              error instanceof Error
                ? error.message
                : 'Не удалось удалить канал',
            )
          }),
        ),
        Effect.ensuring(Effect.sync(() => setDeletingChannel(false))),
      ),
    )
  }

  const label = getChannelLabel(channel, users, currentUserId)
  const active = channel._id === activeChannelId
  const notificationBadge = useSyncStore((s) =>
    selectChannelNotificationBadge(s, channel),
  )
  const voiceCall = useSyncStore((s) => s.voiceCalls[channel._id])
  const voiceCallRingingDismissed = useSyncStore((s) =>
    isVoiceCallRingingDismissed(voiceCall, s.dismissedVoiceCallKeys),
  )
  const dmRecipientId = getDmRecipientId(channel, currentUserId)
  const dmUser = dmRecipientId ? users[dmRecipientId] : undefined
  const isServerChannel = channel.channel_type === 'TextChannel'
  const serverVoice = isServerVoiceChannel(channel)
  const restrictedTextChannel =
    channel.channel_type === 'TextChannel' &&
    !serverVoice &&
    server != null &&
    isChannelAccessRestricted(server, channel)
  const incomingVoiceCall =
    !voiceCallRingingDismissed && isIncomingVoiceCall(voiceCall, currentUserId)
  const voiceCallMarkerTitle =
    voiceCall?.phase === 'active'
      ? 'Идёт звонок'
      : incomingVoiceCall
        ? 'Входящий звонок'
        : null

  async function markRead() {
    if (!token) return
    const lastId = getChannelLastMessageId(channel)
    if (!lastId) return
    syncStore.setChannelLastRead(channel._id, lastId)
    await Effect.runPromise(
      ackChannelEffect(token, channel._id, lastId).pipe(
        Effect.matchEffect({
          onFailure: () =>
            Effect.sync(() =>
              toast.error('Не удалось отметить прочитанным'),
            ),
          onSuccess: () =>
            Effect.sync(() =>
              toast.success('Канал отмечен прочитанным'),
            ),
        }),
      ),
    )
  }

  async function copyLink() {
    const url = publicAppUrl(`/app/c/${channel._id}`)
    await Effect.runPromise(
      writeClipboardTextEffect(url).pipe(
        Effect.matchEffect({
          onFailure: () =>
            Effect.sync(() => toast.error('Не удалось скопировать')),
          onSuccess: () =>
            Effect.sync(() => toast.success('Ссылка скопирована')),
        }),
      ),
    )
  }

  async function createInvite() {
    if (!token || channel.channel_type !== 'TextChannel') return
    await Effect.runPromise(
      Effect.gen(function*() {
        const invite = yield* createChannelInviteEffect(
          token,
          channel._id,
          {},
        )
        const code = '_id' in invite ? invite._id : ''
        if (!code) return
        yield* writeClipboardTextEffect(inviteUrl(code))
        yield* Effect.sync(() => toast.success('Приглашение скопировано'))
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            toast.error(
              error instanceof Error ? error.message : 'Не удалось создать',
            )
          }),
        ),
      ),
    )
  }

  function handleVoiceChannelClick(event: MouseEvent<HTMLAnchorElement>) {
    if (!serverVoice || !canJoinVoiceChannel(channel)) return
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return
    }

    const action = resolveVoiceChannelClickAction({
      clickedChannelId: channel._id,
      voiceChannelId: voice.channelId,
      voiceStatus: voice.status,
    })

    event.preventDefault()

    if (isMobile) {
      mobileVoiceChannelDrawer?.openVoiceChannelDrawer(channel._id)
      return
    }

    if (action === 'open') {
      void navigate({
        to: channelRoute,
        params: { channelId: channel._id },
        search: { m: undefined },
      })
    } else {
      void voice.join(channel._id)
    }
  }

  function openVoiceChannelChat(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
    requestVoiceChannelChatOpen(channel._id)

    if (isMobile) {
      mobileVoiceChannelDrawer?.openVoiceChannelDrawer(channel._id)
      return
    }

    if (active) return

    void navigate({
      to: channelRoute,
      params: { channelId: channel._id },
      search: { m: undefined },
    })
  }

  function handleVoiceDragOver(event: DragEvent<HTMLDivElement>) {
    if (
      !serverVoice ||
      movingVoiceMember ||
      !event.dataTransfer.types.includes(VOICE_MEMBER_DRAG_TYPE)
    ) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    setVoiceDropActive(true)
  }

  function handleVoiceDragLeave(event: DragEvent<HTMLDivElement>) {
    const relatedTarget = event.relatedTarget
    if (
      relatedTarget instanceof Node &&
      event.currentTarget.contains(relatedTarget)
    ) {
      return
    }
    setVoiceDropActive(false)
  }

  async function handleVoiceDrop(event: DragEvent<HTMLDivElement>) {
    if (!serverVoice || !token || !server || !auth.user?._id) return
    event.preventDefault()
    event.stopPropagation()
    setVoiceDropActive(false)

    const payload = readVoiceMemberDragPayload(event.dataTransfer)
    if (
      !payload ||
      payload.serverId !== server._id ||
      payload.channelId === channel._id
    ) {
      return
    }

    const state = syncStore.getState()
    const targetMember = state.members[`${server._id}:${payload.userId}`]
    const actorMember = state.members[`${server._id}:${auth.user._id}`]
    const mayMove = canMoveServerMember(
      server,
      actorMember,
      auth.user._id,
      targetMember,
    )
    if (!mayMove) {
      toast.error('Недостаточно прав для перемещения участника')
      return
    }

    setMovingVoiceMember(true)
    await Effect.runPromise(
      editServerMemberEffect(
        token,
        server._id,
        payload.userId,
        { voice_channel: channel._id },
      ).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() => {
              toast.error(
                error instanceof Error
                  ? error.message
                  : 'Не удалось переместить участника',
              )
            }),
          onSuccess: () =>
            Effect.sync(() => toast.success('Участник перемещён')),
        }),
        Effect.ensuring(Effect.sync(() => setMovingVoiceMember(false))),
      ),
    )
  }

  const channelActionButtonClassName =
    'flex size-6 shrink-0 self-center items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity group-hover/channel:opacity-100 hover:bg-accent/80 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50'

  const row = (
    <div
      className={cn(
        'group/channel flex flex-col',
        dragging && 'opacity-60',
        voiceDropActive && 'rounded-md bg-chart-3/15 ring-1 ring-chart-3/70',
      )}
      data-channel-sidebar-item=""
      data-voice-drop-pending={movingVoiceMember ? 'true' : 'false'}
      onDragOver={handleVoiceDragOver}
      onDragLeave={handleVoiceDragLeave}
      onDrop={(event) => void handleVoiceDrop(event)}
    >
      <div
        className={cn(
          'relative flex h-9 min-w-0 items-stretch rounded-md text-sm transition-colors',
          active
            ? 'bg-secondary text-secondary-foreground'
            : 'text-foreground hover:bg-accent hover:text-accent-foreground',
        )}
      >
        {!active && notificationBadge.hasUnread ? (
          <RailUnreadIndicator className="-left-2" />
        ) : null}
        <Link
          to={channelRoute}
          params={{ channelId: channel._id }}
          search={{ m: undefined }}
          className={cn(
            'flex h-full min-w-0 flex-1 items-center gap-2 px-2 font-normal',
            canManage &&
              dragHandleProps &&
              'cursor-grab touch-none active:cursor-grabbing',
          )}
          onClick={serverVoice ? handleVoiceChannelClick : undefined}
          {...(canManage && dragHandleProps ? dragHandleProps : {})}
        >
          {channel.channel_type === 'DirectMessage' && dmUser ? (
            <UserAvatar
              user={dmUser}
              className="size-6"
              fallbackClassName="size-6 text-[10px]"
            />
          ) : channel.channel_type === 'Group' ? (
            channel.icon ? (
              <img
                src={attachmentPreviewUrl(channel.icon)}
                alt=""
                className="size-4 shrink-0 rounded-sm object-cover"
              />
            ) : (
              <span
                title="Групповой чат"
                className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
              >
                <UsersIcon aria-hidden="true" className="size-4" />
              </span>
            )
          ) : serverVoice ? (
            <VoiceChannelIcon channel={channel} server={server} />
          ) : restrictedTextChannel ? (
            <span
              title="Закрытый текстовый канал"
              className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
            >
              <RestrictedTextChannelIcon className="size-4" />
            </span>
          ) : (
            <HashIcon className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {voiceCallMarkerTitle ? (
            <span
              title={voiceCallMarkerTitle}
              className="flex size-5 shrink-0 items-center justify-center rounded-full bg-chart-3/15 text-chart-3"
            >
              <HeadphonesIcon aria-hidden="true" className="size-3.5" />
            </span>
          ) : null}
        </Link>
        {serverVoice || (canManage && isServerChannel) ? (
          <div className="mr-1 flex shrink-0 self-center items-center gap-0.5">
            {serverVoice ? (
              <button
                type="button"
                className={channelActionButtonClassName}
                title="Открыть чат"
                aria-label="Открыть чат"
                onClick={openVoiceChannelChat}
              >
                <MessageSquareIcon className="size-3.5" />
              </button>
            ) : null}
            {canManage && isServerChannel ? (
              <button
                type="button"
                className={channelActionButtonClassName}
                title="Настройки канала"
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  openChannelSettings()
                }}
              >
                <SettingsIcon className="size-3.5" />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {serverVoice ? <VoiceChannelPreview channelId={channel._id} /> : null}
    </div>
  )

  const menuItems = (
    <>
      <ContextMenuItem onSelect={() => void markRead()}>
        <CheckCheckIcon className="size-3.5" />
        Прочитано
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => void copyLink()}>
        <LinkIcon className="size-3.5" />
        Копировать ссылку
      </ContextMenuItem>
      {channel.channel_type === 'TextChannel' && canInvite ? (
        <ContextMenuItem onSelect={() => void createInvite()}>
          <LinkIcon className="size-3.5" />
          Приглашение
        </ContextMenuItem>
      ) : null}
      {canManage && isServerChannel ? (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={openChannelSettings}>
            <SettingsIcon className="size-3.5" />
            Настройки канала
          </ContextMenuItem>
        </>
      ) : null}
      {canDeleteChannel && isServerChannel ? (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            onSelect={() => setDeleteDialogOpen(true)}
          >
            <Trash2Icon className="size-3.5" />
            Удалить канал
          </ContextMenuItem>
        </>
      ) : null}
    </>
  )

  return (
    <>
      {isServerChannel ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
          <ContextMenuContent className="w-52">{menuItems}</ContextMenuContent>
        </ContextMenu>
      ) : (
        row
      )}
      {canDeleteChannel && isServerChannel ? (
        <Dialog
          open={deleteDialogOpen}
          onOpenChange={(open) => {
            if (!deletingChannel) setDeleteDialogOpen(open)
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Удалить канал «{channel.name}»?</DialogTitle>
              <DialogDescription>
                Это действие необратимо. Сообщения и настройки канала будут
                удалены.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={deletingChannel}
                onClick={() => setDeleteDialogOpen(false)}
              >
                Отмена
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={deletingChannel}
                onClick={() => void handleDeleteChannel()}
              >
                Удалить канал
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  )
}
