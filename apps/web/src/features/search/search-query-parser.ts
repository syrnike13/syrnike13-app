import type { User } from '@syrnike13/api-types'

/** Значения фильтра `has:`. */
export type MessageSearchHas = 'link' | 'image' | 'file' | 'video'

export type MessageSearchFilterKind = 'from' | 'mentions' | 'has'

export type ParsedMessageSearchFilter = {
  kind: MessageSearchFilterKind
  /** Что показываем в чипе — то, что ввёл пользователь. */
  label: string
  /** Что уходит на сервер. */
  value: string
  /** Ник не нашёлся среди известных пользователей: сервер вернёт пусто. */
  resolved: boolean
}

export type ParsedMessageSearchQuery = {
  /** Свободный текст: всё, что не распознано фильтром. */
  query: string
  /** По одному фильтру каждого вида — побеждает последний. */
  filters: ParsedMessageSearchFilter[]
  from?: string
  mentions?: string
  has?: MessageSearchHas
}

const HAS_VALUES: readonly MessageSearchHas[] = [
  'link',
  'image',
  'file',
  'video',
]

const FILTER_PATTERN = /^(from|mentions|has):(.*)$/i
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/i

function findUserId(value: string, users: Record<string, User>) {
  const bare = value.replace(/^@/, '').trim()
  if (!bare) return undefined

  if (ULID_PATTERN.test(bare)) return bare

  const wanted = bare.toLowerCase()
  for (const user of Object.values(users)) {
    if (user.username.toLowerCase() === wanted) return user._id
    if ((user.display_name ?? '').toLowerCase() === wanted) return user._id
  }

  return undefined
}

/**
 * Разбирает поисковую строку вида `текст from:ник mentions:me has:image`.
 *
 * Неизвестный или пустой фильтр остаётся обычным текстом — запрос не падает.
 * Ник резолвим в id по известным пользователям; если не нашли, значение уходит
 * как есть, и сервер просто не найдёт совпадений.
 */
export function parseMessageSearchQuery(
  raw: string,
  options: { users?: Record<string, User>; currentUserId?: string } = {},
): ParsedMessageSearchQuery {
  const users = options.users ?? {}
  const text: string[] = []
  const parsed: ParsedMessageSearchFilter[] = []

  for (const token of raw.split(/\s+/)) {
    if (!token) continue

    const match = FILTER_PATTERN.exec(token)
    const kind = match?.[1]?.toLowerCase()
    const value = match?.[2]?.trim() ?? ''

    if (!match || !kind || !value) {
      text.push(token)
      continue
    }

    if (kind === 'has') {
      const has = value.toLowerCase()
      if (!HAS_VALUES.includes(has as MessageSearchHas)) {
        text.push(token)
        continue
      }

      parsed.push({
        kind: 'has',
        label: `has:${has}`,
        value: has,
        resolved: true,
      })
      continue
    }

    const filterKind: MessageSearchFilterKind =
      kind === 'from' ? 'from' : 'mentions'
    const mentionsMe =
      filterKind === 'mentions' && value.toLowerCase() === 'me'
    const userId = mentionsMe
      ? options.currentUserId
      : findUserId(value, users)

    parsed.push({
      kind: filterKind,
      label: `${filterKind}:${value}`,
      value: userId ?? value,
      resolved: Boolean(userId),
    })
  }

  const lastOf = (kind: MessageSearchFilterKind) =>
    parsed.filter((filter) => filter.kind === kind).at(-1)

  const filters = (['from', 'mentions', 'has'] as const)
    .map((kind) => lastOf(kind))
    .filter((filter): filter is ParsedMessageSearchFilter => filter !== undefined)

  return {
    query: text.join(' ').trim(),
    filters,
    from: lastOf('from')?.value,
    mentions: lastOf('mentions')?.value,
    has: lastOf('has')?.value as MessageSearchHas | undefined,
  }
}
