/**
 * Unicode emoji catalog for the picker: emojibase labels and tags in the UI
 * locale, iamcal (Slack/Discord-style) shortcodes, grouped like Discord.
 * Only emoji the backend accepts (`unicode_emoji.txt`) are offered, so a
 * picked reaction is never rejected. Loaded lazily on first picker open.
 */

export type EmojiCategoryId =
  | 'people'
  | 'nature'
  | 'food'
  | 'activities'
  | 'travel'
  | 'objects'
  | 'symbols'
  | 'flags'

export type UnicodeEmoji = {
  unicode: string
  label: string
  shortcode: string
  /** Lowercased label, tags and shortcodes for search. */
  search: string
  /** Skin tone variants, light to dark. */
  skins?: string[]
}

export type EmojiCatalog = {
  categories: { id: EmojiCategoryId; emojis: UnicodeEmoji[] }[]
  byUnicode: Map<string, UnicodeEmoji>
}

type CompactEmoji = {
  unicode: string
  hexcode: string
  label: string
  group?: number
  order?: number
  tags?: string[]
  skins?: { unicode: string }[]
}

/** emojibase groups (meta/groups.json) to Discord's categories; 2 = components. */
const GROUP_CATEGORY: Record<number, EmojiCategoryId> = {
  0: 'people',
  1: 'people',
  3: 'nature',
  4: 'food',
  5: 'travel',
  6: 'activities',
  7: 'objects',
  8: 'symbols',
  9: 'flags',
}

export const EMOJI_CATEGORY_ORDER: EmojiCategoryId[] = [
  'people',
  'nature',
  'food',
  'activities',
  'travel',
  'objects',
  'symbols',
  'flags',
]

const stripVariation = (value: string) => value.replace(/️/g, '')

async function loadCompact(locale: string): Promise<CompactEmoji[]> {
  const module =
    locale === 'ru'
      ? await import('emojibase-data/ru/compact.json')
      : await import('emojibase-data/en/compact.json')
  return module.default as unknown as CompactEmoji[]
}

const cache = new Map<string, Promise<EmojiCatalog>>()

export function loadEmojiCatalog(locale: string): Promise<EmojiCatalog> {
  const key = locale === 'ru' ? 'ru' : 'en'
  let pending = cache.get(key)
  if (!pending) {
    pending = buildCatalog(key)
    cache.set(key, pending)
  }
  return pending
}

async function buildCatalog(locale: string): Promise<EmojiCatalog> {
  const [compact, shortcodes, allowedText] = await Promise.all([
    loadCompact(locale),
    import('emojibase-data/en/shortcodes/iamcal.json').then(
      (module) => module.default as unknown as Record<string, string | string[]>,
    ),
    import('../../../../services/backend/crates/core/database/src/models/emojis/unicode_emoji.txt?raw').then(
      (module) => module.default as string,
    ),
  ])
  const allowed = new Set(allowedText.split('\n').map((line) => stripVariation(line.trim())))

  const buckets = new Map<EmojiCategoryId, (UnicodeEmoji & { order: number })[]>()
  const byUnicode = new Map<string, UnicodeEmoji>()

  for (const entry of compact) {
    const category = entry.group == null ? undefined : GROUP_CATEGORY[entry.group]
    if (!category || !allowed.has(stripVariation(entry.unicode))) continue

    const codes = shortcodes[entry.hexcode]
    const names = codes == null ? [] : Array.isArray(codes) ? codes : [codes]
    const shortcode = names[0] ?? entry.label.toLowerCase().replace(/\s+/g, '_')
    const skins = entry.skins
      ?.map((skin) => skin.unicode)
      .filter((unicode) => allowed.has(stripVariation(unicode)))

    const emoji: UnicodeEmoji & { order: number } = {
      unicode: entry.unicode,
      label: entry.label,
      shortcode,
      search: [entry.label, ...(entry.tags ?? []), ...names].join(' ').toLowerCase(),
      skins: skins?.length === 5 ? skins : undefined,
      order: entry.order ?? 0,
    }
    byUnicode.set(entry.unicode, emoji)
    const bucket = buckets.get(category) ?? []
    bucket.push(emoji)
    buckets.set(category, bucket)
  }

  return {
    categories: EMOJI_CATEGORY_ORDER.map((id) => ({
      id,
      emojis: (buckets.get(id) ?? []).sort((a, b) => a.order - b.order),
    })),
    byUnicode,
  }
}

const FREQUENT_KEY = 'syrnike.emoji.frequent'
const FREQUENT_LIMIT = 27

/** Most used emoji (unicode or custom ids), per browser. */
export function readFrequentEmoji(): string[] {
  try {
    const raw = localStorage.getItem(FREQUENT_KEY)
    const counts = raw ? (JSON.parse(raw) as Record<string, number>) : {}
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, FREQUENT_LIMIT)
      .map(([emoji]) => emoji)
  } catch {
    return []
  }
}

export function recordEmojiUse(emoji: string) {
  try {
    const raw = localStorage.getItem(FREQUENT_KEY)
    const counts = raw ? (JSON.parse(raw) as Record<string, number>) : {}
    counts[emoji] = (counts[emoji] ?? 0) + 1
    localStorage.setItem(FREQUENT_KEY, JSON.stringify(counts))
  } catch {
    // Storage blocked: frequent emoji just stay at the defaults.
  }
}
