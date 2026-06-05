import { describe, expect, it } from 'vitest'

import {
  applyChannelDragResult,
  appendChannelToCategory,
  beforeCategoryDroppableId,
  resolveChannelDragDestination,
  serializeServerLayout,
  serverLayoutEquals,
  sortSectionChannelsTextBeforeVoice,
  UNCATEGORIZED_SECTION_ID,
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

describe('serializeServerLayout', () => {
  it('flattens uncategorized channels before categorized channels', () => {
    const layout = sections([
      {
        id: UNCATEGORIZED_SECTION_ID,
        title: null,
        channels: [channel('unc-2'), channel('unc-1')],
      },
      {
        id: 'cat-a',
        title: 'A',
        channels: [channel('cat-a-1'), voiceChannel('cat-a-v')],
      },
    ])

    expect(
      serializeServerLayout(layout, [
        'unc-2',
        'unc-1',
        'cat-a-1',
        'cat-a-v',
      ]).channels,
    ).toEqual(['unc-2', 'unc-1', 'cat-a-1', 'cat-a-v'])
  })

  it('appends missing existing channel ids at the end', () => {
    const layout = sections([
      { id: 'cat-a', title: 'A', channels: [channel('cat-a-1')] },
    ])

    expect(
      serializeServerLayout(layout, ['legacy-1', 'cat-a-1']).channels,
    ).toEqual(['cat-a-1', 'legacy-1'])
  })

  it('detects uncategorized reorder without category changes', () => {
    const baseline = sections([
      {
        id: UNCATEGORIZED_SECTION_ID,
        title: null,
        channels: [channel('unc-1'), channel('unc-2')],
      },
    ])
    const reordered = sections([
      {
        id: UNCATEGORIZED_SECTION_ID,
        title: null,
        channels: [channel('unc-2'), channel('unc-1')],
      },
    ])
    const existing = ['unc-1', 'unc-2']

    const previous = serializeServerLayout(baseline, existing)
    const next = serializeServerLayout(reordered, existing)

    expect(previous.categories).toEqual(next.categories)
    expect(serverLayoutEquals(previous, next)).toBe(false)
    expect(next.channels).toEqual(['unc-2', 'unc-1'])
  })

  it('updates both categories and channels when moving into a category', () => {
    const baseline = sections([
      {
        id: UNCATEGORIZED_SECTION_ID,
        title: null,
        channels: [channel('unc-1'), channel('unc-2')],
      },
      { id: 'cat-a', title: 'A', channels: [channel('cat-a-1')] },
    ])
    const nextSections = applyChannelDragResult(
      baseline,
      { droppableId: UNCATEGORIZED_SECTION_ID, index: 0 },
      { droppableId: 'cat-a', index: 0 },
    )
    const existing = ['unc-1', 'unc-2', 'cat-a-1']

    const previous = serializeServerLayout(baseline, existing)
    const next = serializeServerLayout(nextSections, existing)

    expect(serverLayoutEquals(previous, next)).toBe(false)
    expect(next.categories[0]?.channels).toEqual(['unc-1', 'cat-a-1'])
    expect(next.channels).toEqual(['unc-2', 'unc-1', 'cat-a-1'])
  })
})
