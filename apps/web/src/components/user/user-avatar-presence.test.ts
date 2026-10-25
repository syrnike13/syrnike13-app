import { describe, expect, it } from 'vitest'

import {
  resolveAvatarBadgeLayout,
  resolveAvatarSizePx,
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

describe('resolveAvatarBadgeLayout', () => {
  it('keeps the status dot Discord-sized for each avatar size', () => {
    const presence = { kind: 'presence' } as const
    expect(resolveAvatarBadgeLayout(32, presence)).toEqual({
      sizePx: 10,
      widthPx: 10,
      gapPx: 3,
    })
    expect(resolveAvatarBadgeLayout(80, presence).sizePx).toBe(16)
    expect(resolveAvatarBadgeLayout(120, presence).sizePx).toBe(24)
  })

  it('widens the unread pill with its label', () => {
    const one = resolveAvatarBadgeLayout(40, { kind: 'count', label: '1' })
    const many = resolveAvatarBadgeLayout(40, { kind: 'count', label: '99+' })
    expect(one.widthPx).toBe(one.sizePx)
    expect(many.sizePx).toBe(one.sizePx)
    expect(many.widthPx).toBeGreaterThan(one.widthPx)
  })

})
