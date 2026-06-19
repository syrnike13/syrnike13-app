// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ServerChannelList } from '#/components/channels/server-channel-list'
import { syncStore } from '#/features/sync/sync-store'
import { UNCATEGORIZED_SECTION_ID } from '#/lib/channel-sidebar-layout'

const mocks = vi.hoisted(() => ({
  editServer: vi.fn(() => new Promise(() => {})),
  onDragEnd: null as null | ((result: unknown) => void),
}))

vi.mock('@hello-pangea/dnd', () => ({
  DragDropContext: ({
    children,
    onDragEnd,
  }: {
    children: ReactNode
    onDragEnd: (result: unknown) => void
  }) => {
    mocks.onDragEnd = onDragEnd
    return <div>{children}</div>
  },
  Droppable: ({
    children,
  }: {
    children: (provided: unknown) => ReactNode
  }) => (
    <div>
      {children({
        innerRef: vi.fn(),
        droppableProps: {},
        placeholder: null,
      })}
    </div>
  ),
  Draggable: ({
    children,
  }: {
    children: (provided: unknown, snapshot: unknown) => ReactNode
  }) => (
    <div>
      {children(
        {
          innerRef: vi.fn(),
          draggableProps: {},
          dragHandleProps: {},
        },
        { isDragging: false },
      )}
    </div>
  ),
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    session: { token: 'session-token' },
    user: { _id: 'user-current', username: 'alice' },
  }),
}))

vi.mock('#/features/api/servers-api', () => ({
  editServer: (...args: Parameters<typeof mocks.editServer>) =>
    mocks.editServer(...args),
}))

vi.mock('#/components/channels/channel-sidebar-item', () => ({
  ChannelSidebarItem: ({ channel }: { channel: { name: string } }) => (
    <div data-testid="channel">{channel.name}</div>
  ),
}))

vi.mock('#/components/channels/channel-category-header', () => ({
  ChannelCategoryHeader: () => null,
}))

vi.mock('#/components/channels/create-category-dialog', () => ({
  CreateCategoryDialog: () => null,
}))

vi.mock('#/components/servers/create-channel-dialog', () => ({
  CreateChannelDialog: () => null,
}))

vi.mock('#/components/ui/floating-menu', () => ({
  FloatingMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FloatingMenuItem: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
}))

function channelNames() {
  return screen.queryAllByTestId('channel').map((item) => item.textContent)
}

describe('ServerChannelList', () => {
  beforeEach(() => {
    mocks.editServer.mockClear()
    mocks.onDragEnd = null
    localStorage.clear()
    syncStore.reset()
    syncStore.upsertServer({
      _id: 'server-a',
      name: 'Alpha',
      owner: 'user-current',
      channels: ['channel-a', 'channel-b'],
      default_permissions: 0,
    } as never)
    syncStore.upsertChannel({
      _id: 'channel-a',
      channel_type: 'TextChannel',
      server: 'server-a',
      name: 'Alpha',
    } as never)
    syncStore.upsertChannel({
      _id: 'channel-b',
      channel_type: 'TextChannel',
      server: 'server-a',
      name: 'Beta',
    } as never)
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
  })

  it('keeps optimistic channel order while reorder persistence is pending', () => {
    render(
      <ServerChannelList
        serverId="server-a"
        users={{}}
        currentUserId="user-current"
        unreads={{}}
      />,
    )
    expect(channelNames()).toEqual(['Alpha', 'Beta'])

    act(() => {
      mocks.onDragEnd?.({
        source: { droppableId: UNCATEGORIZED_SECTION_ID, index: 0 },
        destination: { droppableId: UNCATEGORIZED_SECTION_ID, index: 1 },
      })
    })

    expect(mocks.editServer).toHaveBeenCalledOnce()
    expect(channelNames()).toEqual(['Beta', 'Alpha'])
  })

  it('keeps unread channels visible inside collapsed categories', () => {
    syncStore.upsertServer({
      _id: 'server-a',
      name: 'Alpha',
      owner: 'user-current',
      channels: ['channel-a', 'channel-b'],
      default_permissions: 0,
      categories: [
        {
          id: 'category-a',
          title: 'Read later',
          channels: ['channel-a', 'channel-b'],
        },
      ],
    } as never)
    syncStore.upsertChannel({
      _id: 'channel-a',
      channel_type: 'TextChannel',
      server: 'server-a',
      name: 'Alpha',
      last_message_id: 'message-2',
    } as never)
    syncStore.upsertChannel({
      _id: 'channel-b',
      channel_type: 'TextChannel',
      server: 'server-a',
      name: 'Beta',
      last_message_id: 'message-2',
    } as never)
    localStorage.setItem(
      'channel-category-collapsed:server-a:category-a',
      '1',
    )

    render(
      <ServerChannelList
        serverId="server-a"
        users={{}}
        currentUserId="user-current"
        unreads={{
          'channel-a': 'message-1',
          'channel-b': 'message-2',
        }}
      />,
    )

    expect(channelNames()).toEqual(['Alpha'])
  })

  it('keeps the active channel visible inside collapsed categories', () => {
    syncStore.upsertServer({
      _id: 'server-a',
      name: 'Alpha',
      owner: 'user-current',
      channels: ['channel-a', 'channel-b'],
      default_permissions: 0,
      categories: [
        {
          id: 'category-a',
          title: 'Read later',
          channels: ['channel-a', 'channel-b'],
        },
      ],
    } as never)
    localStorage.setItem(
      'channel-category-collapsed:server-a:category-a',
      '1',
    )

    render(
      <ServerChannelList
        serverId="server-a"
        activeChannelId="channel-b"
        users={{}}
        currentUserId="user-current"
        unreads={{}}
      />,
    )

    expect(channelNames()).toEqual(['Beta'])
  })
})
