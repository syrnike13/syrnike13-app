import type { User } from '@syrnike13/api-types'
import { describe, expect, it } from 'vitest'

import { parseMessageSearchQuery } from '#/features/search/search-query-parser'

const CURRENT_USER_ID = '01KT7DEM3B0T4B0BXGBXWDJ700'
const BOB_ID = '01KT7DEM3B0T4B0BXGBXWDJ701'

const users: Record<string, User> = {
  [CURRENT_USER_ID]: {
    _id: CURRENT_USER_ID,
    username: 'alice',
    discriminator: '0001',
    online: true,
  } as User,
  [BOB_ID]: {
    _id: BOB_ID,
    username: 'bob',
    display_name: 'Борис',
    discriminator: '0002',
    online: true,
  } as User,
}

function parse(raw: string) {
  return parseMessageSearchQuery(raw, {
    users,
    currentUserId: CURRENT_USER_ID,
  })
}

describe('parseMessageSearchQuery', () => {
  it('keeps plain text as the query', () => {
    const parsed = parse('привет мир')

    expect(parsed.query).toBe('привет мир')
    expect(parsed.filters).toEqual([])
    expect(parsed.from).toBeUndefined()
  })

  it('resolves a nickname in from: to a user id', () => {
    const parsed = parse('отчёт from:bob')

    expect(parsed.query).toBe('отчёт')
    expect(parsed.from).toBe(BOB_ID)
    expect(parsed.filters).toEqual([
      { kind: 'from', label: 'from:bob', value: BOB_ID, resolved: true },
    ])
  })

  it('accepts a user id in from: without a lookup', () => {
    const parsed = parse(`from:${BOB_ID}`)

    expect(parsed.query).toBe('')
    expect(parsed.from).toBe(BOB_ID)
    expect(parsed.filters[0]?.resolved).toBe(true)
  })

  it('resolves a display name and strips the leading @', () => {
    expect(parse('from:@Борис').from).toBe(BOB_ID)
  })

  it('resolves mentions:me to the current user', () => {
    const parsed = parse('mentions:me has:image')

    expect(parsed.mentions).toBe(CURRENT_USER_ID)
    expect(parsed.has).toBe('image')
    expect(parsed.filters.map((filter) => filter.label)).toEqual([
      'mentions:me',
      'has:image',
    ])
  })

  it('keeps an unknown nickname as the filter value but marks it unresolved', () => {
    const parsed = parse('from:ghost')

    expect(parsed.query).toBe('')
    expect(parsed.from).toBe('ghost')
    expect(parsed.filters[0]?.resolved).toBe(false)
  })

  it('treats an unknown has: value and an empty from: as plain text', () => {
    const parsed = parse('has:banana from: смотри')

    expect(parsed.query).toBe('has:banana from: смотри')
    expect(parsed.filters).toEqual([])
    expect(parsed.has).toBeUndefined()
  })

  it('does not mistake a url or a bare word with a colon for a filter', () => {
    const parsed = parse('https://example.com/page fromme:x')

    expect(parsed.query).toBe('https://example.com/page fromme:x')
    expect(parsed.filters).toEqual([])
  })

  it('is case insensitive for filter names and has: values', () => {
    const parsed = parse('HAS:IMAGE From:bob')

    expect(parsed.has).toBe('image')
    expect(parsed.from).toBe(BOB_ID)
  })

  it('keeps the last filter of the same kind', () => {
    const parsed = parse('has:image has:video from:alice from:bob')

    expect(parsed.has).toBe('video')
    expect(parsed.from).toBe(BOB_ID)
    expect(parsed.filters.map((filter) => filter.label)).toEqual([
      'from:bob',
      'has:video',
    ])
  })

  it('collapses extra whitespace between text and filters', () => {
    const parsed = parse('  отчёт   from:bob   ')

    expect(parsed.query).toBe('отчёт')
  })
})
