import { describe, expect, it } from 'vitest'

import {
  applyChannelDragResult,
  appendChannelToCategory,
  beforeCategoryDroppableId,
  resolveChannelDragDestination,
  sortSectionChannelsTextBeforeVoice,
  type ChannelSidebarSection,
  type ServerChannel,
} from '#/lib/channel-sidebar-layout'

const channel = (id: string): ServerChannel =>
  ({
    _id: id,
    channel_type: 'TextChannel',
    server: 'server-1',
    name: id,
  }) as ServerChannel

const voiceChannel = (id: string): ServerChannel =>
  ({
    _id: id,
    channel_type: 'TextChannel',
    server: 'server-1',
    name: id,
    voice: { max_users: null },
  }) as ServerChannel

const sections = (
  entries: Array<{
    id: string
    title: string | null
    channels: ServerChannel[]
  }>,
): ChannelSidebarSection[] =>
  entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    channels: entry.channels,
  }))

describe('resolveChannelDragDestination', () => {
  it('maps before-category on empty category into the category', () => {
    const layout = sections([
      { id: 'cat-a', title: 'A', channels: [channel('ch-1')] },
      { id: 'cat-b', title: 'B', channels: [] },
    ])

    const resolved = resolveChannelDragDestination(
      layout,
      { droppableId: 'cat-a', index: 0 },
      { droppableId: beforeCategoryDroppableId('cat-b'), index: 0 },
      null,
      {},
      {},
    )

    expect(resolved).toEqual({ droppableId: 'cat-b', index: 0 })
  })

  it('prefers empty category bounds over after-category extract slots', () => {
    const layout = sections([
      { id: 'cat-a', title: 'A', channels: [channel('ch-1')] },
      { id: 'cat-b', title: 'B', channels: [] },
    ])

    const resolved = resolveChannelDragDestination(
      layout,
      { droppableId: 'cat-a', index: 0 },
      { droppableId: 'after-category:cat-a', index: 0 },
      170,
      {},
      { 'cat-b': { top: 100, bottom: 140 } },
    )

    expect(resolved).toEqual({ droppableId: 'cat-b', index: 0 })
  })

  it('remaps after-category to the next empty category in the drop zone', () => {
    const layout = sections([
      { id: 'cat-a', title: 'A', channels: [channel('ch-1')] },
      { id: 'cat-b', title: 'B', channels: [] },
    ])

    const resolved = resolveChannelDragDestination(
      layout,
      { droppableId: 'cat-a', index: 0 },
      { droppableId: 'after-category:cat-a', index: 0 },
      155,
      {},
      { 'cat-b': { top: 100, bottom: 140 } },
    )

    expect(resolved).toEqual({ droppableId: 'cat-b', index: 0 })
  })
})

describe('applyChannelDragResult', () => {
  it('adds a channel to an empty category', () => {
    const layout = sections([
      { id: 'cat-a', title: 'A', channels: [channel('ch-1')] },
      { id: 'cat-b', title: 'B', channels: [] },
    ])

    const next = applyChannelDragResult(
      layout,
      { droppableId: 'cat-a', index: 0 },
      { droppableId: 'cat-b', index: 0 },
    )

    expect(next.find((section) => section.id === 'cat-a')?.channels).toEqual([])
    expect(next.find((section) => section.id === 'cat-b')?.channels.map((c) => c._id)).toEqual([
      'ch-1',
    ])
  })
})

describe('sortSectionChannelsTextBeforeVoice', () => {
  it('keeps text channels before voice channels', () => {
    const sorted = sortSectionChannelsTextBeforeVoice([
      voiceChannel('voice-1'),
      channel('text-1'),
      voiceChannel('voice-2'),
      channel('text-2'),
    ])

    expect(sorted.map((entry) => entry._id)).toEqual([
      'text-1',
      'text-2',
      'voice-1',
      'voice-2',
    ])
  })
})

describe('applyChannelDragResult channel ordering', () => {
  it('moves voice channels below text channels after drag', () => {
    const layout = sections([
      {
        id: 'cat-a',
        title: 'A',
        channels: [channel('text-1'), voiceChannel('voice-1')],
      },
    ])

    const next = applyChannelDragResult(
      layout,
      { droppableId: 'cat-a', index: 1 },
      { droppableId: 'cat-a', index: 0 },
    )

    expect(next[0]?.channels.map((entry) => entry._id)).toEqual([
      'text-1',
      'voice-1',
    ])
  })
})

describe('appendChannelToCategory', () => {
  it('inserts text channels before existing voice channels', () => {
    const categories = appendChannelToCategory(
      [{ id: 'cat-a', title: 'A', channels: ['text-old', 'voice-1'] }],
      'cat-a',
      'text-new',
      {
        isVoice: false,
        isVoiceId: (id) => id.startsWith('voice-'),
      },
    )

    expect(categories[0]?.channels).toEqual(['text-old', 'text-new', 'voice-1'])
  })
})
