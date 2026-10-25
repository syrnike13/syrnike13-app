const TAILWIND_SIZE_PX: Record<string, number> = {
  '0': 0,
  '0.5': 2,
  '1': 4,
  '1.5': 6,
  '2': 8,
  '2.5': 10,
  '3': 12,
  '3.5': 14,
  '4': 16,
  '5': 20,
  '6': 24,
  '7': 28,
  '8': 32,
  '9': 36,
  '10': 40,
  '11': 44,
  '12': 48,
  '14': 56,
  '16': 64,
  '20': 80,
  '24': 96,
  '28': 112,
  '32': 128,
  '36': 144,
  '40': 160,
  '44': 176,
  '48': 192,
  '52': 208,
  '56': 224,
  '60': 240,
  '64': 256,
  '72': 288,
  '80': 320,
  '96': 384,
}

/** Оценка диаметра аватарки в px по tailwind-классам size-*. */
export function resolveAvatarSizePx(
  ...classNames: Array<string | undefined>
): number {
  for (const className of classNames) {
    if (!className) continue

    const arbitraryPx = className.match(/\bsize-\[(\d+(?:\.\d+)?)px]/)
    if (arbitraryPx) return Number(arbitraryPx[1])

    const arbitraryRem = className.match(/\bsize-\[([\d.]+)rem]/)
    if (arbitraryRem) return Number(arbitraryRem[1]) * 16

    const tokens = className.match(/\bsize-([\d.]+)\b/g)
    if (!tokens) continue

    const key = tokens[tokens.length - 1]!.replace('size-', '')
    const px = TAILWIND_SIZE_PX[key] ?? Number(key) * 4
    if (Number.isFinite(px)) return px
  }

  return 32
}

type BadgeTier = { maxAvatarPx: number; sizePx: number; gapPx: number }

/** Discord-like status dot sizes. */
const PRESENCE_DOT_TIERS: readonly BadgeTier[] = [
  { maxAvatarPx: 20, sizePx: 6, gapPx: 1.5 },
  { maxAvatarPx: 28, sizePx: 8, gapPx: 2 },
  { maxAvatarPx: 36, sizePx: 10, gapPx: 3 },
  { maxAvatarPx: 44, sizePx: 12, gapPx: 3 },
  { maxAvatarPx: 56, sizePx: 14, gapPx: 3 },
  { maxAvatarPx: 88, sizePx: 16, gapPx: 4 },
  { maxAvatarPx: Infinity, sizePx: 24, gapPx: 5 },
]

/** Discord-like unread count pill heights. */
const COUNT_BADGE_TIERS: readonly BadgeTier[] = [
  { maxAvatarPx: 28, sizePx: 12, gapPx: 2 },
  { maxAvatarPx: 44, sizePx: 16, gapPx: 3 },
  { maxAvatarPx: 64, sizePx: 18, gapPx: 3 },
  { maxAvatarPx: Infinity, sizePx: 20, gapPx: 4 },
]

function tierFor(tiers: readonly BadgeTier[], avatarPx: number) {
  return (
    tiers.find((tier) => avatarPx <= tier.maxAvatarPx) ?? tiers[tiers.length - 1]!
  )
}

export type AvatarBadgeLayout = {
  sizePx: number
  widthPx: number
  gapPx: number
  fontPx?: number
}

/**
 * Geometry for the avatar's corner badge: a status dot, or an unread count
 * pill that widens with its label. Feeds the `avatar-badge-*` CSS variables.
 */
export function resolveAvatarBadgeLayout(
  avatarPx: number,
  badge: { kind: 'presence' } | { kind: 'count'; label: string },
): AvatarBadgeLayout {
  if (badge.kind === 'presence') {
    const tier = tierFor(PRESENCE_DOT_TIERS, avatarPx)
    return { sizePx: tier.sizePx, widthPx: tier.sizePx, gapPx: tier.gapPx }
  }
  const tier = tierFor(COUNT_BADGE_TIERS, avatarPx)
  const extraChars = Math.max(0, badge.label.length - 1)
  return {
    sizePx: tier.sizePx,
    widthPx: Math.round(tier.sizePx * (1 + 0.45 * extraChars)),
    gapPx: tier.gapPx,
    fontPx: Math.round(tier.sizePx * 0.68),
  }
}
