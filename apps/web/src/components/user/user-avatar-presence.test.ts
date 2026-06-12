import { describe, expect, it } from 'vitest'

import {
  PRESENCE_BADGE_SIZE_SCALE,
  resolveAvatarSizePx,
  resolvePresenceBadgeLayout,
  resolvePresenceBadgeLayoutForAvatar,
} from '#/components/user/user-avatar-presence'

describe('resolveAvatarSizePx', () => {
  it('parses tailwind size tokens', () => {
    expect(resolveAvatarSizePx('size-6')).toBe(24)
    expect(resolveAvatarSizePx('size-8', 'size-8 text-xs')).toBe(32)
    expect(resolveAvatarSizePx(undefined, 'size-24 text-2xl')).toBe(96)
  })

  it('parses arbitrary pixel sizes', () => {
    expect(resolveAvatarSizePx('size-[88px]')).toBe(88)
  })

  it('falls back to size-8', () => {
    expect(resolveAvatarSizePx()).toBe(32)
  })
})

describe('resolvePresenceBadgeLayout', () => {
  it('scales badge size with PRESENCE_BADGE_SIZE_SCALE', () => {
    expect(resolvePresenceBadgeLayout(24)).toEqual({
      sizePx: Math.round(6 * PRESENCE_BADGE_SIZE_SCALE),
      ringPx: Math.round(1 * PRESENCE_BADGE_SIZE_SCALE),
      offsetClass: 'translate-x-[20%] translate-y-[20%]',
    })
    expect(resolvePresenceBadgeLayout(32)).toEqual({
      sizePx: Math.round(8 * PRESENCE_BADGE_SIZE_SCALE),
      ringPx: Math.round(2 * PRESENCE_BADGE_SIZE_SCALE),
      offsetClass: 'translate-x-[18%] translate-y-[18%]',
    })
    expect(resolvePresenceBadgeLayout(88)).toEqual({
      sizePx: Math.round(16 * PRESENCE_BADGE_SIZE_SCALE),
      ringPx: Math.round(3 * PRESENCE_BADGE_SIZE_SCALE),
      offsetClass: 'translate-x-[14%] translate-y-[14%]',
    })
  })
})

describe('resolvePresenceBadgeLayoutForAvatar', () => {
  it('derives badge size from avatar class names', () => {
    expect(
      resolvePresenceBadgeLayoutForAvatar('size-6', 'size-6 text-[10px]').sizePx,
    ).toBe(Math.round(6 * PRESENCE_BADGE_SIZE_SCALE))
    expect(
      resolvePresenceBadgeLayoutForAvatar(
        'size-[88px]',
        'size-[88px] text-2xl',
      ).sizePx,
    ).toBe(Math.round(16 * PRESENCE_BADGE_SIZE_SCALE))
  })
})
