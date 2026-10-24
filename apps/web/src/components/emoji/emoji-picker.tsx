import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Emoji, Server } from '@syrnike13/api-types'
import { useLocale, useTranslations } from '@syrnike13/ui/i18n'

import { CustomEmoji } from '#/components/emoji/custom-emoji'
import {
  EmojiActivitiesIcon,
  EmojiFlagsIcon,
  EmojiFoodIcon,
  EmojiNatureIcon,
  EmojiObjectsIcon,
  EmojiPeopleIcon,
  EmojiRecentIcon,
  EmojiSymbolsIcon,
  EmojiTravelIcon,
  SearchIcon,
} from '#/components/icons'
import { serverAcronym } from '#/components/servers/server-avatar'
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from '@syrnike13/ui/primitives/avatar'
import { Button } from '@syrnike13/ui/primitives/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@syrnike13/ui/primitives/dropdown-menu'
import { Empty, EmptyDescription } from '@syrnike13/ui/primitives/empty'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@syrnike13/ui/primitives/input-group'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@syrnike13/ui/primitives/popover'
import { ScrollArea } from '@syrnike13/ui/primitives/scroll-area'
import { Spinner } from '@syrnike13/ui/primitives/spinner'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@syrnike13/ui/primitives/tooltip'
import { useSyncStore } from '#/features/sync/sync-store'
import {
  loadEmojiCatalog,
  readFrequentEmoji,
  recordEmojiUse,
  type EmojiCategoryId,
  type UnicodeEmoji,
} from '#/lib/emoji-catalog'
import { isCustomEmojiId } from '#/lib/emoji'
import { serverIconUrl } from '#/lib/media'
import { QUICK_REACTIONS } from '#/lib/reactions'

type EmojiPickerProps = {
  trigger: ReactElement
  /** Unicode emoji (with the chosen skin tone) or a custom emoji id. */
  onPick: (emoji: string) => void
  /** Current server: its emoji are listed first. */
  serverId?: string | null
  open?: boolean
  onOpenChange?: (open: boolean) => void
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'bottom' | 'left' | 'right'
}

/**
 * Discord-style emoji picker without GIFs and stickers: search, skin tone,
 * a category rail (frequent, every server's emoji, Unicode categories), a
 * sectioned grid and a preview footer. Click picks and closes; Shift+click
 * keeps the picker open. Any server's emoji can be used anywhere — the
 * backend only rejects deleted ones.
 */
export function EmojiPicker({
  trigger,
  onPick,
  serverId,
  open: openProp,
  onOpenChange,
  align = 'end',
  side = 'top',
}: EmojiPickerProps) {
  const [openInternal, setOpenInternal] = useState(false)
  const open = openProp ?? openInternal
  const setOpen = (next: boolean) => {
    setOpenInternal(next)
    onOpenChange?.(next)
  }
  const searchRef = useRef<HTMLInputElement>(null)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverContent
        align={align}
        side={side}
        initialFocus={searchRef}
        className="h-110 w-105 gap-0 overflow-hidden p-0"
      >
        <EmojiPickerPanel
          serverId={serverId}
          searchRef={searchRef}
          onPick={(emoji, keepOpen) => {
            recordEmojiUse(emoji)
            onPick(emoji)
            if (!keepOpen) setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

type PickerItem =
  | { kind: 'unicode'; emoji: UnicodeEmoji }
  | { kind: 'raw'; unicode: string }
  | { kind: 'custom'; emoji: Emoji; serverName?: string }

type PickerSection = {
  id: string
  title: string
  rail: ReactNode
  items: PickerItem[]
}

const SKIN_TONE_KEY = 'syrnike.emoji.skin'
const SKIN_SWATCHES = ['✋', '✋🏻', '✋🏼', '✋🏽', '✋🏾', '✋🏿']

const CATEGORY_ICONS: Record<EmojiCategoryId, ReactNode> = {
  people: <EmojiPeopleIcon />,
  nature: <EmojiNatureIcon />,
  food: <EmojiFoodIcon />,
  activities: <EmojiActivitiesIcon />,
  travel: <EmojiTravelIcon />,
  objects: <EmojiObjectsIcon />,
  symbols: <EmojiSymbolsIcon />,
  flags: <EmojiFlagsIcon />,
}

function readSkinTone() {
  try {
    const value = Number(localStorage.getItem(SKIN_TONE_KEY))
    return Number.isInteger(value) && value >= 0 && value <= 5 ? value : 0
  } catch {
    return 0
  }
}

function ServerRailIcon({ server }: { server: Server }) {
  const icon = serverIconUrl(server.icon, { animated: false })
  return (
    <Avatar className="size-6">
      {icon ? <AvatarImage src={icon} alt="" /> : null}
      <AvatarFallback className="text-3xs">{serverAcronym(server.name)}</AvatarFallback>
    </Avatar>
  )
}

function EmojiPickerPanel({
  serverId,
  searchRef,
  onPick,
}: {
  serverId?: string | null
  searchRef: React.RefObject<HTMLInputElement | null>
  onPick: (emoji: string, keepOpen: boolean) => void
}) {
  const t = useTranslations('chat.emojiPicker')
  const { locale } = useLocale()
  const catalogQuery = useQuery({
    queryKey: ['emoji-catalog', locale],
    queryFn: () => loadEmojiCatalog(locale),
    staleTime: Infinity,
  })
  const catalog = catalogQuery.data
  const servers = useSyncStore((s) => s.servers)
  const customEmojis = useSyncStore((s) => s.emojis)

  const [query, setQuery] = useState('')
  const [skinTone, setSkinTone] = useState(readSkinTone)
  const [preview, setPreview] = useState<PickerItem | null>(null)
  const [activeSection, setActiveSection] = useState('frequent')
  const viewportRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef(new Map<string, HTMLElement>())
  const frequent = useMemo(() => {
    const used = readFrequentEmoji()
    return used.length > 0 ? used : [...QUICK_REACTIONS]
  }, [])

  const sections = useMemo<PickerSection[]>(() => {
    const serverEmoji = new Map<string, Emoji[]>()
    for (const emoji of Object.values(customEmojis)) {
      if (emoji.parent.type !== 'Server' || !servers[emoji.parent.id]) continue
      const list = serverEmoji.get(emoji.parent.id) ?? []
      list.push(emoji)
      serverEmoji.set(emoji.parent.id, list)
    }
    const serverIds = [...serverEmoji.keys()].sort((a, b) =>
      a === serverId ? -1 : b === serverId ? 1 : 0,
    )

    return [
      {
        id: 'frequent',
        title: t('frequent'),
        rail: <EmojiRecentIcon />,
        items: frequent.flatMap((emoji): PickerItem[] => {
          if (isCustomEmojiId(emoji)) {
            const custom = customEmojis[emoji]
            return custom ? [{ kind: 'custom', emoji: custom }] : []
          }
          const known = catalog?.byUnicode.get(emoji)
          return [known ? { kind: 'unicode', emoji: known } : { kind: 'raw', unicode: emoji }]
        }),
      },
      ...serverIds.map((id) => {
        const server = servers[id]!
        return {
          id: `server:${id}`,
          title: server.name,
          rail: <ServerRailIcon server={server} />,
          items: serverEmoji
            .get(id)!
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((emoji): PickerItem => ({ kind: 'custom', emoji, serverName: server.name })),
        }
      }),
      ...(catalog?.categories ?? []).map((category) => ({
        id: category.id,
        title: t(category.id),
        rail: CATEGORY_ICONS[category.id],
        items: category.emojis.map((emoji): PickerItem => ({ kind: 'unicode', emoji })),
      })),
    ]
  }, [catalog, customEmojis, frequent, serverId, servers, t])

  const search = query.trim().toLowerCase()
  const results = useMemo(() => {
    if (!search) return null
    const seen = new Set<string>()
    const ranked: { item: PickerItem; rank: number }[] = []
    for (const section of sections) {
      if (section.id === 'frequent') continue
      for (const item of section.items) {
        const key = itemKey(item)
        if (seen.has(key)) continue
        seen.add(key)
        const rank = searchRank(item, search)
        if (rank !== null) ranked.push({ item, rank })
      }
    }
    return ranked.sort((a, b) => a.rank - b.rank).map(({ item }) => item)
  }, [search, sections])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || results) return
    const onScroll = () => {
      let current = sections[0]?.id ?? 'frequent'
      for (const section of sections) {
        const element = sectionRefs.current.get(section.id)
        if (element && element.offsetTop - viewport.scrollTop <= 8) current = section.id
      }
      setActiveSection(current)
    }
    viewport.addEventListener('scroll', onScroll, { passive: true })
    return () => viewport.removeEventListener('scroll', onScroll)
  }, [results, sections])

  const withSkin = (emoji: UnicodeEmoji) =>
    skinTone > 0 && emoji.skins ? emoji.skins[skinTone - 1]! : emoji.unicode

  const pick = (item: PickerItem, event: MouseEvent) => {
    const value =
      item.kind === 'custom'
        ? item.emoji._id
        : item.kind === 'unicode'
          ? withSkin(item.emoji)
          : item.unicode
    onPick(value, event.shiftKey)
  }

  const shown = preview ?? sections[0]?.items[0] ?? null

  const grid = (items: PickerItem[]) => (
    <div className="grid grid-cols-9 gap-0.5 px-2 pb-2">
      {items.map((item) => (
        <Button
          key={itemKey(item)}
          type="button"
          variant="ghost"
          size="icon-lg"
          aria-label={itemName(item)}
          onMouseEnter={() => setPreview(item)}
          onFocus={() => setPreview(item)}
          onClick={(event) => pick(item, event)}
        >
          <EmojiGlyph item={item} size="lg" render={withSkin} />
        </Button>
      ))}
    </div>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border p-2">
        <InputGroup className="flex-1">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            ref={searchRef}
            value={query}
            placeholder={t('search')}
            aria-label={t('search')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </InputGroup>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-lg"
                title={t('skinTone')}
                aria-label={t('skinTone')}
              />
            }
          >
            <span className="text-2xl leading-none">{SKIN_SWATCHES[skinTone]}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-0">
            <DropdownMenuRadioGroup
              value={String(skinTone)}
              onValueChange={(value) => {
                const next = Number(value)
                setSkinTone(next)
                try {
                  localStorage.setItem(SKIN_TONE_KEY, String(next))
                } catch {
                  // Storage blocked: the tone lasts for this picker only.
                }
              }}
            >
              {SKIN_SWATCHES.map((swatch, index) => (
                <DropdownMenuRadioItem key={swatch} value={String(index)}>
                  <span className="text-xl leading-none">{swatch}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex min-h-0 flex-1">
        <ScrollArea className="w-12 shrink-0 border-r border-border">
          <nav className="flex flex-col items-center gap-1 py-2">
            {sections.map((section) => (
              <Tooltip key={section.id}>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={section.title}
                      aria-current={!results && activeSection === section.id ? 'true' : undefined}
                      className="aria-current:bg-selection aria-current:text-selection-foreground"
                      onClick={() => {
                        setQuery('')
                        const element = sectionRefs.current.get(section.id)
                        viewportRef.current?.scrollTo({ top: element?.offsetTop ?? 0 })
                      }}
                    />
                  }
                >
                  {section.rail}
                </TooltipTrigger>
                <TooltipContent side="right">{section.title}</TooltipContent>
              </Tooltip>
            ))}
            {catalogQuery.isPending ? <Spinner className="mt-2" /> : null}
          </nav>
        </ScrollArea>

        <ScrollArea className="min-w-0 flex-1" viewportRef={viewportRef}>
          <div className="relative">
            {results ? (
              results.length > 0 ? (
                <section>
                  <SectionTitle>{t('results')}</SectionTitle>
                  {grid(results)}
                </section>
              ) : (
                <Empty size="sm">
                  <EmptyDescription>{t('noResults')}</EmptyDescription>
                </Empty>
              )
            ) : (
              sections.map((section) => (
                <section
                  key={section.id}
                  ref={(element) => {
                    if (element) sectionRefs.current.set(section.id, element)
                    else sectionRefs.current.delete(section.id)
                  }}
                >
                  <SectionTitle>
                    <span className="flex size-4 items-center justify-center [&_svg]:size-4">
                      {section.rail}
                    </span>
                    {section.title}
                  </SectionTitle>
                  {grid(section.items)}
                </section>
              ))
            )}
          </div>
        </ScrollArea>
      </div>

      <div className="flex h-12 shrink-0 items-center gap-2 border-t border-border px-3">
        {shown ? (
          <>
            <EmojiGlyph item={shown} size="xl" render={withSkin} />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">
                {itemName(shown)}
              </p>
              {shown.kind === 'custom' && shown.serverName ? (
                <p className="truncate text-xs text-muted-foreground">{shown.serverName}</p>
              ) : shown.kind === 'unicode' ? (
                <p className="truncate text-xs text-muted-foreground">{shown.emoji.label}</p>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="sticky top-0 z-10 flex h-8 items-center gap-1.5 bg-popover px-3 text-xs font-semibold text-muted-foreground">
      {children}
    </h3>
  )
}

function EmojiGlyph({
  item,
  size,
  render,
}: {
  item: PickerItem
  size: 'lg' | 'xl'
  render: (emoji: UnicodeEmoji) => string
}) {
  if (item.kind === 'custom') {
    return <CustomEmoji emojiId={item.emoji._id} name={item.emoji.name} size={size} />
  }
  const glyph = item.kind === 'unicode' ? render(item.emoji) : item.unicode
  return (
    <span className={size === 'xl' ? 'text-4xl leading-none' : 'text-2xl leading-none'}>
      {glyph}
    </span>
  )
}

/** 0: name starts with the query, 1: a word does, 2: substring; null: no match. */
function searchRank(item: PickerItem, query: string): number | null {
  if (item.kind === 'raw') return null
  const name = item.kind === 'custom' ? item.emoji.name.toLowerCase() : item.emoji.shortcode
  const haystack = item.kind === 'custom' ? name : item.emoji.search
  if (name.startsWith(query)) return 0
  if (haystack.split(/[\s_]+/).some((word) => word.startsWith(query))) return 1
  return haystack.includes(query) ? 2 : null
}

function itemKey(item: PickerItem) {
  return item.kind === 'custom'
    ? item.emoji._id
    : item.kind === 'unicode'
      ? item.emoji.unicode
      : item.unicode
}

function itemName(item: PickerItem) {
  return item.kind === 'custom'
    ? `:${item.emoji.name}:`
    : item.kind === 'unicode'
      ? `:${item.emoji.shortcode}:`
      : item.unicode
}
