import type { Category, Channel, Server } from '@syrnike13/api-types'

import { isServerVoiceChannel } from '#/lib/channel-voice'

export const UNCATEGORIZED_SECTION_ID = '__uncategorized__'

export type ServerChannel = Extract<Channel, { channel_type: 'TextChannel' }>

export type ChannelSidebarSection = {
  id: string
  title: string | null
  channels: ServerChannel[]
}

export function sortSectionChannelsTextBeforeVoice(
  channels: ServerChannel[],
): ServerChannel[] {
  const text: ServerChannel[] = []
  const voice: ServerChannel[] = []

  for (const channel of channels) {
    if (isServerVoiceChannel(channel)) {
      voice.push(channel)
    } else {
      text.push(channel)
    }
  }

  return [...text, ...voice]
}

function sortSection(section: ChannelSidebarSection): ChannelSidebarSection {
  return {
    ...section,
    channels: sortSectionChannelsTextBeforeVoice(section.channels),
  }
}

function sortSections(sections: ChannelSidebarSection[]): ChannelSidebarSection[] {
  return sections.map(sortSection)
}

function insertChannelIdTextBeforeVoice(
  channelIds: string[],
  channelId: string,
  isVoice: boolean,
  isVoiceId: (id: string) => boolean,
): string[] {
  const withoutChannel = channelIds.filter((id) => id !== channelId)
  if (isVoice) {
    return [...withoutChannel, channelId]
  }

  const firstVoiceIndex = withoutChannel.findIndex(isVoiceId)
  if (firstVoiceIndex === -1) {
    return [...withoutChannel, channelId]
  }

  return [
    ...withoutChannel.slice(0, firstVoiceIndex),
    channelId,
    ...withoutChannel.slice(firstVoiceIndex),
  ]
}

export function buildChannelSidebarSections(
  server: Server,
  channels: ServerChannel[],
): ChannelSidebarSection[] {
  const byId = new Map(channels.map((channel) => [channel._id, channel]))
  const categorised = new Set<string>()
  const sections: ChannelSidebarSection[] = []

  for (const category of server.categories ?? []) {
    const categoryChannels = category.channels
      .map((id) => byId.get(id))
      .filter((channel): channel is ServerChannel => Boolean(channel))

    for (const id of category.channels) {
      categorised.add(id)
    }

    sections.push({
      id: category.id,
      title: category.title,
      channels: categoryChannels,
    })
  }

  const uncategorized = (server.channels ?? [])
    .map((id) => byId.get(id))
    .filter(
      (channel): channel is ServerChannel =>
        Boolean(channel && !categorised.has(channel._id)),
    )

  if (uncategorized.length > 0) {
    sections.unshift({
      id: UNCATEGORIZED_SECTION_ID,
      title: null,
      channels: uncategorized,
    })
  }

  if (sections.length === 0 && channels.length > 0) {
    sections.push({
      id: UNCATEGORIZED_SECTION_ID,
      title: null,
      channels: [...channels],
    })
  }

  return sortSections(sections)
}

/** Невидимая секция «без категории» — чтобы вытаскивать каналы наверх. */
export function beforeCategoryDroppableId(categoryId: string) {
  return `before-category:${categoryId}`
}

export function parseBeforeCategoryDroppableId(droppableId: string) {
  if (!droppableId.startsWith('before-category:')) return null
  return droppableId.slice('before-category:'.length)
}

export function afterCategoryDroppableId(categoryId: string) {
  return `after-category:${categoryId}`
}

export function parseAfterCategoryDroppableId(droppableId: string) {
  if (!droppableId.startsWith('after-category:')) return null
  return droppableId.slice('after-category:'.length)
}

export function isCategorySectionId(
  sections: ChannelSidebarSection[],
  sectionId: string,
) {
  return sections.some(
    (section) => section.id === sectionId && section.title !== null,
  )
}

export function getNextCategorySectionId(
  sections: ChannelSidebarSection[],
  categoryId: string,
) {
  const categories = sections.filter((section) => section.title !== null)
  const index = categories.findIndex((section) => section.id === categoryId)
  if (index === -1 || index >= categories.length - 1) return null
  return categories[index + 1]!.id
}

export function getCategorySection(
  sections: ChannelSidebarSection[],
  categoryId: string,
) {
  return sections.find(
    (section) => section.id === categoryId && section.title !== null,
  )
}

export const EMPTY_CATEGORY_CHANNEL_SLOT_HEIGHT = 36

function expandEmptyCategoryBounds(rect: { top: number; bottom: number }) {
  return {
    top: rect.top - 4,
    bottom: rect.bottom + EMPTY_CATEGORY_CHANNEL_SLOT_HEIGHT + 8,
  }
}

function isPointerInsideRect(
  pointerY: number | null,
  rect: { top: number; bottom: number } | undefined,
) {
  if (pointerY === null || !rect) return false
  return pointerY >= rect.top && pointerY <= rect.bottom
}

function resolveEmptyCategoryDrop(
  sections: ChannelSidebarSection[],
  categoryId: string,
  emptyCategoryBoundsByCategoryId: Record<
    string,
    { top: number; bottom: number }
  >,
  pointerY: number | null,
) {
  const category = getCategorySection(sections, categoryId)
  if (!category || category.channels.length > 0) return null

  const bounds = emptyCategoryBoundsByCategoryId[categoryId]
  if (!bounds) return null

  if (isPointerInsideRect(pointerY, expandEmptyCategoryBounds(bounds))) {
    return { droppableId: categoryId, index: 0 }
  }

  return null
}

export function remapChannelDragDestination(
  sections: ChannelSidebarSection[],
  source: { droppableId: string; index: number },
  destination: { droppableId: string; index: number },
  pointerY: number | null,
  firstChannelTopByCategoryId: Record<string, number>,
) {
  if (
    parseBeforeCategoryDroppableId(destination.droppableId) ||
    parseAfterCategoryDroppableId(destination.droppableId)
  ) {
    return destination
  }

  if (destination.index !== 0) return destination
  if (!isCategorySectionId(sections, destination.droppableId)) return destination
  if (source.droppableId === UNCATEGORIZED_SECTION_ID) return destination
  if (!isCategorySectionId(sections, source.droppableId)) return destination

  const destinationSection = sections.find(
    (section) => section.id === destination.droppableId,
  )
  if (destinationSection?.channels.length === 0) return destination

  const nextCategoryId = getNextCategorySectionId(
    sections,
    source.droppableId,
  )
  if (nextCategoryId !== destination.droppableId || pointerY === null) {
    return destination
  }

  const firstChannelTop = firstChannelTopByCategoryId[destination.droppableId]
  if (firstChannelTop === undefined) return destination

  if (pointerY < firstChannelTop) {
    return {
      droppableId: afterCategoryDroppableId(source.droppableId),
      index: 0,
    }
  }

  return destination
}

export function resolveChannelDragDestination(
  sections: ChannelSidebarSection[],
  source: { droppableId: string; index: number },
  destination: { droppableId: string; index: number } | null,
  pointerY: number | null,
  firstChannelTopByCategoryId: Record<string, number>,
  emptyCategoryBoundsByCategoryId: Record<
    string,
    { top: number; bottom: number }
  >,
): { droppableId: string; index: number } | null {
  if (pointerY !== null) {
    for (const categoryId of Object.keys(emptyCategoryBoundsByCategoryId)) {
      const resolved = resolveEmptyCategoryDrop(
        sections,
        categoryId,
        emptyCategoryBoundsByCategoryId,
        pointerY,
      )
      if (resolved) return resolved
    }
  }

  if (!destination) return null

  const beforeCategoryId = parseBeforeCategoryDroppableId(destination.droppableId)
  if (beforeCategoryId) {
    const category = getCategorySection(sections, beforeCategoryId)
    if (category?.channels.length === 0) {
      return { droppableId: beforeCategoryId, index: 0 }
    }
    return destination
  }

  const afterCategoryId = parseAfterCategoryDroppableId(destination.droppableId)
  if (afterCategoryId && pointerY !== null) {
    const nextCategoryId = getNextCategorySectionId(sections, afterCategoryId)
    if (nextCategoryId) {
      const resolved = resolveEmptyCategoryDrop(
        sections,
        nextCategoryId,
        emptyCategoryBoundsByCategoryId,
        pointerY,
      )
      if (resolved) return resolved
    }
  }

  return remapChannelDragDestination(
    sections,
    source,
    destination,
    pointerY,
    firstChannelTopByCategoryId,
  )
}

export function ensureUncategorizedSection(
  sections: ChannelSidebarSection[],
): ChannelSidebarSection[] {
  const hasCategories = sections.some((section) => section.title !== null)
  if (!hasCategories) return sections

  const uncategorized = sections.find(
    (section) => section.id === UNCATEGORIZED_SECTION_ID,
  )
  if (uncategorized) return sections

  return [
    {
      id: UNCATEGORIZED_SECTION_ID,
      title: null,
      channels: [],
    },
    ...sections,
  ]
}

export function sectionsToCategories(
  sections: ChannelSidebarSection[],
): Category[] {
  return sections
    .filter((section) => section.id !== UNCATEGORIZED_SECTION_ID)
    .map((section) => ({
      id: section.id,
      title: section.title ?? '',
      channels: sortSectionChannelsTextBeforeVoice(section.channels).map(
        (channel) => channel._id,
      ),
    }))
}

function cloneSections(sections: ChannelSidebarSection[]) {
  return sections.map((section) => ({
    ...section,
    channels: [...section.channels],
  }))
}

function moveChannelToUncategorized(
  sections: ChannelSidebarSection[],
  source: { droppableId: string; index: number },
): ChannelSidebarSection[] {
  const next = cloneSections(ensureUncategorizedSection(sections))
  const sourceSection = next.find((section) => section.id === source.droppableId)
  const uncategorized = next.find(
    (section) => section.id === UNCATEGORIZED_SECTION_ID,
  )
  if (!sourceSection || !uncategorized) return sections

  const [moved] = sourceSection.channels.splice(source.index, 1)
  if (!moved) return sections

  let insertIndex = uncategorized.channels.length
  if (
    source.droppableId === UNCATEGORIZED_SECTION_ID &&
    source.index < insertIndex
  ) {
    insertIndex -= 1
  }

  uncategorized.channels.splice(insertIndex, 0, moved)
  return sortSections(next)
}

export function applyChannelDragResult(
  sections: ChannelSidebarSection[],
  source: { droppableId: string; index: number },
  destination: { droppableId: string; index: number },
): ChannelSidebarSection[] {
  if (
    parseBeforeCategoryDroppableId(destination.droppableId) ||
    parseAfterCategoryDroppableId(destination.droppableId)
  ) {
    return moveChannelToUncategorized(sections, source)
  }

  const next = cloneSections(sections)

  const sourceSection = next.find((section) => section.id === source.droppableId)
  const destinationSection = next.find(
    (section) => section.id === destination.droppableId,
  )
  if (!sourceSection || !destinationSection) return sections

  const [moved] = sourceSection.channels.splice(source.index, 1)
  if (!moved) return sections

  destinationSection.channels.splice(destination.index, 0, moved)
  return sortSections(next)
}

export function moveChannelInSections(
  sections: ChannelSidebarSection[],
  activeId: string,
  overId: string,
): ChannelSidebarSection[] {
  return moveChannelToSection(sections, activeId, null, overId)
}

export function moveChannelToSection(
  sections: ChannelSidebarSection[],
  activeId: string,
  targetSectionId: string | null,
  overChannelId: string | null,
): ChannelSidebarSection[] {
  const next = sections.map((section) => ({
    ...section,
    channels: [...section.channels],
  }))

  let sourceSectionId: string | null = null
  let sourceIndex = -1
  let moved: ServerChannel | undefined

  for (const section of next) {
    const index = section.channels.findIndex((channel) => channel._id === activeId)
    if (index !== -1) {
      sourceSectionId = section.id
      sourceIndex = index
      moved = section.channels.splice(index, 1)[0]
      break
    }
  }

  if (!moved) return sections

  let resolvedTargetSectionId = targetSectionId
  const resolvedOverChannelId = overChannelId

  if (!resolvedTargetSectionId && resolvedOverChannelId) {
    for (const section of next) {
      if (section.channels.some((channel) => channel._id === resolvedOverChannelId)) {
        resolvedTargetSectionId = section.id
        break
      }
    }
  }

  if (!resolvedTargetSectionId) return sections

  const target = next.find((section) => section.id === resolvedTargetSectionId)
  if (!target) return sections

  if (resolvedOverChannelId) {
    let index = target.channels.findIndex(
      (channel) => channel._id === resolvedOverChannelId,
    )
    if (index !== -1) {
      if (sourceSectionId === target.id && sourceIndex < index) {
        index -= 1
      }
      target.channels.splice(index, 0, moved)
      return sortSections(next)
    }
  }

  target.channels.push(moved)
  return sortSections(next)
}

export function parseChannelDropTarget(overId: string) {
  if (overId.startsWith('section:')) {
    return {
      sectionId: overId.slice('section:'.length),
      channelId: null as string | null,
    }
  }

  return {
    sectionId: null as string | null,
    channelId: overId,
  }
}

export function appendChannelToCategory(
  categories: Category[] | null | undefined,
  categoryId: string,
  channelId: string,
  options?: {
    isVoice?: boolean
    isVoiceId?: (id: string) => boolean
  },
): Category[] {
  const next = (categories ?? []).map((category) => ({
    ...category,
    channels: [...category.channels],
  }))

  const target = next.find((category) => category.id === categoryId)
  if (!target || target.channels.includes(channelId)) {
    return next
  }

  for (const category of next) {
    category.channels = category.channels.filter((id) => id !== channelId)
  }

  const isVoiceId =
    options?.isVoiceId ??
    ((id: string) => {
      if (id === channelId) return options?.isVoice ?? false
      return false
    })

  target.channels = insertChannelIdTextBeforeVoice(
    target.channels,
    channelId,
    options?.isVoice ?? false,
    isVoiceId,
  )
  return next
}

export function createCategoryId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 26)
}
