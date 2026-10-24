import { useTranslations } from '@syrnike13/ui/i18n'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { User } from '@syrnike13/api-types'
import { Effect } from 'effect'
import {
  DragDropContext,
  Draggable,
  Droppable,
  type DropResult,
} from '@hello-pangea/dnd'
import { FolderPlusIcon, PlusCircleIcon } from '#/components/icons'
import { toast } from 'sonner'

import { ChannelCategoryHeader } from '#/components/channels/channel-category-header'
import { ChannelSidebarItem } from '#/components/channels/channel-sidebar-item'
import { CreateCategoryDialog } from '#/components/channels/create-category-dialog'
import { CreateChannelDialog } from '#/components/servers/create-channel-dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@syrnike13/ui/primitives/context-menu'
import { useAuth } from '#/features/auth/auth-context'
import { editServerEffect } from '#/features/api/servers-api'
import { listServerChannels } from '#/features/sync/selectors'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import type { ChannelUnreadState } from '#/features/sync/types'
import { GUILD_BANNER_CONTENT_OFFSET_CLASS } from '#/components/layout/shell-chrome'
import {
  applyChannelDragResult,
  afterCategoryDroppableId,
  beforeCategoryDroppableId,
  buildChannelSidebarSections,
  ensureUncategorizedSection,
  resolveChannelDragDestination,
  serializeServerLayout,
  serverLayoutEquals,
  UNCATEGORIZED_SECTION_ID,
  type ChannelSidebarSection,
  type ServerChannel,
} from '#/lib/channel-sidebar-layout'
import { canInviteToChannel, canManageServerChannels } from '#/features/authorization/authorization'
import { apiErrorMessage } from '#/lib/api/error-message'
import { cn } from '#/lib/utils'

type ServerChannelListProps = {
  serverId: string
  activeChannelId?: string
  users: Record<string, User>
  currentUserId?: string
  unreads: Record<string, ChannelUnreadState | undefined>
  /** Оставляет место под видимую часть баннера сервера. */
  bannerOffset?: boolean
}

function collapsedStorageKey(serverId: string, categoryId: string) {
  return `channel-category-collapsed:${serverId}:${categoryId}`
}

function readCollapsed(serverId: string, categoryId: string) {
  try {
    return localStorage.getItem(collapsedStorageKey(serverId, categoryId)) === '1'
  } catch {
    return false
  }
}

function writeCollapsed(serverId: string, categoryId: string, collapsed: boolean) {
  try {
    localStorage.setItem(
      collapsedStorageKey(serverId, categoryId),
      collapsed ? '1' : '0',
    )
  } catch {
    // ignore
  }
}

function ServerChannelListFrame({
  serverId,
  canManage,
  bannerOffset = false,
  children,
}: {
  serverId: string
  canManage: boolean
  bannerOffset?: boolean
  children: ReactNode
}) {
  const t = useTranslations('channels')
  const [createChannelOpen, setCreateChannelOpen] = useState(false)
  const [createCategoryOpen, setCreateCategoryOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return

    const viewport = root.closest('[data-slot="scroll-area-viewport"]')
    if (!(viewport instanceof HTMLElement)) return

    const syncHeight = () => {
      root.style.height = `${viewport.clientHeight}px`
    }

    syncHeight()
    const observer = new ResizeObserver(syncHeight)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  return (
    <>
      <div ref={rootRef} className="flex min-h-full flex-col px-2 pt-3 pb-4">
        {bannerOffset ? (
          <div
            aria-hidden="true"
            className={cn('shrink-0', GUILD_BANNER_CONTENT_OFFSET_CLASS)}
          />
        ) : null}
        <div className="shrink-0">{children}</div>
        {canManage ? (
          <ContextMenu>
            <ContextMenuTrigger
              render={<div className="min-h-8 flex-1" aria-hidden />}
            />
            <ContextMenuContent>
              <ContextMenuItem onClick={() => setCreateChannelOpen(true)}>
                <PlusCircleIcon />
                {t('createChannel')}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => setCreateCategoryOpen(true)}>
                <FolderPlusIcon />
                {t('createCategory.title')}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ) : null}
      </div>

      {canManage ? (
        <>
          <CreateChannelDialog
            serverId={serverId}
            open={createChannelOpen}
            onOpenChange={setCreateChannelOpen}
          />
          <CreateCategoryDialog
            serverId={serverId}
            open={createCategoryOpen}
            onOpenChange={setCreateCategoryOpen}
          />
        </>
      ) : null}
    </>
  )
}

function CategoryExtractSlot({ droppableId }: { droppableId: string }) {
  return (
    <Droppable droppableId={droppableId}>
      {(provided) => (
        <div
          ref={provided.innerRef}
          {...provided.droppableProps}
          className="shrink-0"
        >
          {provided.placeholder}
        </div>
      )}
    </Droppable>
  )
}

function ChannelDroppableList({
  sectionId,
  channels,
  activeChannelId,
  users,
  currentUserId,
  unreads,
  canManage,
  canInvite,
  canDrag,
  onFirstChannelElement,
}: {
  sectionId: string
  channels: ServerChannel[]
  activeChannelId?: string
  users: Record<string, User>
  currentUserId?: string
  unreads: Record<string, ChannelUnreadState | undefined>
  canManage: boolean
  canInvite: (channel: ServerChannel) => boolean
  canDrag: boolean
  onFirstChannelElement?: (element: HTMLElement | null) => void
}) {
  if (!canDrag) {
    return (
      <ul className="flex flex-col gap-0.5">
        {channels.map((channel) => (
          <li key={channel._id}>
            <ChannelSidebarItem
              channel={channel}
              activeChannelId={activeChannelId}
              users={users}
              currentUserId={currentUserId}
              unreads={unreads}
              canManage={canManage}
              canInvite={canInvite(channel)}
            />
          </li>
        ))}
      </ul>
    )
  }

  return (
    <Droppable droppableId={sectionId}>
      {(provided) => (
        <ul
          ref={provided.innerRef}
          {...provided.droppableProps}
          className="flex shrink-0 flex-col gap-0.5"
        >
          {channels.map((channel, index) => (
            <Draggable
              key={channel._id}
              draggableId={channel._id}
              index={index}
            >
              {(dragProvided, dragSnapshot) => (
                <li
                  ref={(element) => {
                    dragProvided.innerRef(element)
                    if (index === 0) {
                      onFirstChannelElement?.(element)
                    }
                  }}
                  {...dragProvided.draggableProps}
                  className={cn(
                    'touch-none',
                    dragSnapshot.isDragging && 'z-50',
                  )}
                >
                  <ChannelSidebarItem
                    channel={channel}
                    activeChannelId={activeChannelId}
                    users={users}
                    currentUserId={currentUserId}
                    unreads={unreads}
                    canManage={canManage}
                    canInvite={canInvite(channel)}
                    dragHandleProps={dragProvided.dragHandleProps ?? undefined}
                  />
                </li>
              )}
            </Draggable>
          ))}
          {provided.placeholder}
        </ul>
      )}
    </Droppable>
  )
}

function ChannelSectionList({
  section,
  serverId,
  activeChannelId,
  users,
  currentUserId,
  unreads,
  canManage,
  canInvite,
  canDrag,
  collapsed,
  onToggleCollapsed,
  onFirstChannelElement,
  onEmptyCategoryElement,
}: {
  section: ChannelSidebarSection
  serverId: string
  activeChannelId?: string
  users: Record<string, User>
  currentUserId?: string
  unreads: Record<string, ChannelUnreadState | undefined>
  canManage: boolean
  canInvite: (channel: ServerChannel) => boolean
  canDrag: boolean
  collapsed: boolean
  onToggleCollapsed?: () => void
  onFirstChannelElement?: (element: HTMLElement | null) => void
  onEmptyCategoryElement?: (element: HTMLElement | null) => void
}) {
  const isUncategorized = section.id === UNCATEGORIZED_SECTION_ID

  if (isUncategorized) {
    if (section.channels.length === 0) {
      return null
    }

    return (
      <ChannelDroppableList
        sectionId={section.id}
        channels={section.channels}
        activeChannelId={activeChannelId}
        users={users}
        currentUserId={currentUserId}
        unreads={unreads}
        canManage={canManage}
        canInvite={canInvite}
        canDrag={canDrag}
      />
    )
  }

  const header = (
    <ChannelCategoryHeader
      serverId={serverId}
      categoryId={section.id}
      title={section.title!}
      collapsed={collapsed}
      canManage={canManage}
      onToggleCollapsed={onToggleCollapsed ?? (() => {})}
    />
  )

  const isEmpty = section.channels.length === 0

  if (isEmpty && canDrag) {
    return (
      <div className="shrink-0">
        <Droppable droppableId={section.id}>
          {(provided) => (
            <div
              ref={(element) => {
                provided.innerRef(element)
                onEmptyCategoryElement?.(element)
              }}
              {...provided.droppableProps}
              className="flex shrink-0 flex-col"
            >
              {provided.placeholder}
              {header}
              {!collapsed ? (
                <div
                  className="h-8 shrink-0"
                  aria-hidden
                  data-empty-category-slot=""
                />
              ) : null}
            </div>
          )}
        </Droppable>
      </div>
    )
  }

  return (
    <div className="shrink-0">
      {canDrag ? (
        <Droppable droppableId={beforeCategoryDroppableId(section.id)}>
          {(provided) => (
            <div
              ref={provided.innerRef}
              {...provided.droppableProps}
              className="shrink-0"
            >
              {provided.placeholder}
              {header}
            </div>
          )}
        </Droppable>
      ) : (
        header
      )}
      {!collapsed ? (
        <>
          <ChannelDroppableList
            sectionId={section.id}
            channels={section.channels}
            activeChannelId={activeChannelId}
            users={users}
            currentUserId={currentUserId}
            unreads={unreads}
            canManage={canManage}
            canInvite={canInvite}
            canDrag={canDrag}
            onFirstChannelElement={onFirstChannelElement}
          />
          {canDrag ? (
            <CategoryExtractSlot droppableId={afterCategoryDroppableId(section.id)} />
          ) : null}
        </>
      ) : null}
    </div>
  )
}

export function ServerChannelList({
  serverId,
  activeChannelId,
  users,
  currentUserId,
  unreads,
  bannerOffset = false,
}: ServerChannelListProps) {
  const t = useTranslations('channels')
  const auth = useAuth()
  const server = useSyncStore((s) => s.servers[serverId])
  const member = useSyncStore(
    (s) => s.members[`${serverId}:${auth.user?._id}`],
  )
  const channels = useSyncStore((s) =>
    listServerChannels(s, serverId, auth.user?._id),
  )

  const canManage = server
    ? canManageServerChannels(
        server,
        member,
        auth.user?._id,
      )
    : false
  const canInvite = useCallback(
    (channel: ServerChannel) =>
      server
        ? canInviteToChannel(
            server,
            channel,
            member,
            auth.user?._id,
          )
        : false,
    [auth.user?._id, member, server],
  )

  const computedSections = useMemo(
    () => (server ? buildChannelSidebarSections(server, channels) : []),
    [server, channels],
  )
  const [optimisticSections, setOptimisticSections] = useState<
    ChannelSidebarSection[] | null
  >(null)

  useEffect(() => {
    if (optimisticSections === null) return
    setOptimisticSections(null)
  }, [computedSections])

  const [reordering, setReordering] = useState(false)
  const pointerYRef = useRef(0)
  const firstChannelElementsRef = useRef<Record<string, HTMLElement>>({})
  const emptyCategoryElementsRef = useRef<Record<string, HTMLElement>>({})
  const pointerTrackingCleanupRef = useRef<(() => void) | null>(null)

  const registerFirstChannel = useCallback(
    (categoryId: string, element: HTMLElement | null) => {
      if (element) {
        firstChannelElementsRef.current[categoryId] = element
        return
      }

      delete firstChannelElementsRef.current[categoryId]
    },
    [],
  )

  const registerEmptyCategory = useCallback(
    (categoryId: string, element: HTMLElement | null) => {
      if (element) {
        emptyCategoryElementsRef.current[categoryId] = element
        return
      }

      delete emptyCategoryElementsRef.current[categoryId]
    },
    [],
  )

  const startPointerTracking = useCallback(() => {
    pointerTrackingCleanupRef.current?.()

    function trackMousePointer(event: globalThis.MouseEvent) {
      pointerYRef.current = event.clientY
    }

    function trackTouchPointer(event: TouchEvent) {
      pointerYRef.current = event.touches[0]?.clientY ?? pointerYRef.current
    }

    window.addEventListener('mousemove', trackMousePointer, { passive: true })
    window.addEventListener('touchmove', trackTouchPointer, { passive: true })

    pointerTrackingCleanupRef.current = () => {
      window.removeEventListener('mousemove', trackMousePointer)
      window.removeEventListener('touchmove', trackTouchPointer)
    }
  }, [])

  const stopPointerTracking = useCallback(() => {
    pointerTrackingCleanupRef.current?.()
    pointerTrackingCleanupRef.current = null
  }, [])

  useEffect(() => () => stopPointerTracking(), [stopPointerTracking])

  const sections = useMemo(() => {
    const base = optimisticSections ?? computedSections
    return canManage ? ensureUncategorizedSection(base) : base
  }, [optimisticSections, computedSections, canManage])

  const [collapsedByCategory, setCollapsedByCategory] = useState<
    Record<string, boolean>
  >({})

  const getCollapsed = useCallback(
    (categoryId: string) =>
      collapsedByCategory[categoryId] ?? readCollapsed(serverId, categoryId),
    [collapsedByCategory, serverId],
  )

  const toggleCollapsed = useCallback(
    (categoryId: string) => {
      setCollapsedByCategory((current) => {
        const next = !(current[categoryId] ?? readCollapsed(serverId, categoryId))
        writeCollapsed(serverId, categoryId, next)
        return { ...current, [categoryId]: next }
      })
    },
    [serverId],
  )

  async function persistSections(nextSections: ChannelSidebarSection[]) {
    const token = auth.session?.token
    if (!token || !server) return

    setReordering(true)
    await Effect.runPromise(
      Effect.gen(function*() {
        const layout = serializeServerLayout(
          nextSections,
          server.channels ?? [],
        )
        const updated = yield* editServerEffect(token, serverId, layout)
        yield* Effect.sync(() => {
          syncStore.upsertServer(updated)
          setOptimisticSections(null)
        })
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            setOptimisticSections(null)
            toast.error(
              apiErrorMessage(error, t('list.orderError')),
            )
          }),
        ),
        Effect.ensuring(Effect.sync(() => setReordering(false))),
      ),
    )
  }

  function handleDragEnd(result: DropResult) {
    stopPointerTracking()

    const { source } = result
    let { destination } = result

    const persistBaseline = optimisticSections ?? computedSections
    const dragBaseline = ensureUncategorizedSection(persistBaseline)

    const firstChannelTopByCategoryId = Object.fromEntries(
      Object.entries(firstChannelElementsRef.current).map(([categoryId, element]) => [
        categoryId,
        element.getBoundingClientRect().top,
      ]),
    )

    const emptyCategoryBoundsByCategoryId = Object.fromEntries(
      Object.entries(emptyCategoryElementsRef.current).map(
        ([categoryId, element]) => {
          const rect = element.getBoundingClientRect()
          return [categoryId, { top: rect.top, bottom: rect.bottom }]
        },
      ),
    )

    destination = resolveChannelDragDestination(
      dragBaseline,
      source,
      destination,
      pointerYRef.current,
      firstChannelTopByCategoryId,
      emptyCategoryBoundsByCategoryId,
    )

    if (!destination || !server) return
    if (
      destination.droppableId === source.droppableId &&
      destination.index === source.index
    ) {
      return
    }

    const nextSections = applyChannelDragResult(
      dragBaseline,
      source,
      destination,
    )
    if (nextSections === dragBaseline) return

    const existingChannelIds = server.channels ?? channels.map((channel) => channel._id)
    const previousLayout = serializeServerLayout(
      ensureUncategorizedSection(persistBaseline),
      existingChannelIds,
    )
    const nextLayout = serializeServerLayout(nextSections, existingChannelIds)
    if (serverLayoutEquals(previousLayout, nextLayout)) {
      return
    }

    setOptimisticSections(nextSections)
    void persistSections(nextSections)
  }

  if (channels.length === 0) {
    return (
      <ServerChannelListFrame
        serverId={serverId}
        canManage={canManage}
        bannerOffset={bannerOffset}
      >
        <p className="px-2 py-4 text-xs text-muted-foreground">
          {t('list.empty')}
        </p>
      </ServerChannelListFrame>
    )
  }

  const list = sections.map((section) => (
    <ChannelSectionList
      key={section.id}
      section={section}
      serverId={serverId}
      activeChannelId={activeChannelId}
      users={users}
      currentUserId={currentUserId}
      unreads={unreads}
      canManage={canManage}
      canInvite={canInvite}
      canDrag={canManage && !reordering}
      collapsed={section.title !== null ? getCollapsed(section.id) : false}
      onToggleCollapsed={
        section.title !== null
          ? () => toggleCollapsed(section.id)
          : undefined
      }
      onFirstChannelElement={
        section.title !== null
          ? (element) => registerFirstChannel(section.id, element)
          : undefined
      }
      onEmptyCategoryElement={
        section.title !== null && section.channels.length === 0
          ? (element) => registerEmptyCategory(section.id, element)
          : undefined
      }
    />
  ))

  if (!canManage) {
    return (
      <ServerChannelListFrame
        serverId={serverId}
        canManage={false}
        bannerOffset={bannerOffset}
      >
        <nav className="flex flex-col gap-0.5">{list}</nav>
      </ServerChannelListFrame>
    )
  }

  return (
    <ServerChannelListFrame
      serverId={serverId}
      canManage
      bannerOffset={bannerOffset}
    >
      <DragDropContext onDragStart={startPointerTracking} onDragEnd={handleDragEnd}>
        <nav className="flex flex-col gap-0.5">{list}</nav>
      </DragDropContext>
    </ServerChannelListFrame>
  )
}
