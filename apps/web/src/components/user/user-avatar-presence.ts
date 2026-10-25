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

export const PRESENCE_BADGE_SIZE_SCALE = 1.3

type PresenceBadgeTier = {
  maxAvatarPx: number
  badgePx: number
  ringPx: number
  offsetClass: string
}

export type PresenceBadgeLayout = {
  sizePx: number
  ringPx: number
  offsetClass: string
}

function scaledBadgePx(px: number) {
  return Math.round(px * PRESENCE_BADGE_SIZE_SCALE)
}

const PRESENCE_BADGE_TIERS: PresenceBadgeTier[] = [
  {
    maxAvatarPx: 20,
    badgePx: 4,
    ringPx: 1,
    offsetClass: 'translate-x-11/50 translate-y-11/50',
  },
  {
    maxAvatarPx: 28,
    badgePx: 6,
    ringPx: 1,
    offsetClass: 'translate-x-1/5 translate-y-1/5',
  },
  {
    maxAvatarPx: 36,
    badgePx: 8,
    ringPx: 2,
    offsetClass: 'translate-x-9/50 translate-y-9/50',
  },
  {
    maxAvatarPx: 44,
    badgePx: 10,
    ringPx: 2,
    offsetClass: 'translate-x-9/50 translate-y-9/50',
  },
  {
    maxAvatarPx: 56,
    badgePx: 12,
    ringPx: 2,
    offsetClass: 'translate-x-4/25 translate-y-4/25',
  },
  {
    maxAvatarPx: 72,
    badgePx: 14,
    ringPx: 3,
    offsetClass: 'translate-x-3/20 translate-y-3/20',
  },
  {
    maxAvatarPx: 88,
    badgePx: 16,
    ringPx: 3,
    offsetClass: 'translate-x-7/50 translate-y-7/50',
  },
  {
    maxAvatarPx: Infinity,
    badgePx: 20,
    ringPx: 4,
    offsetClass: 'translate-x-7/50 translate-y-7/50',
  },
]

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

export function presenceRingColorVar(presenceRingClassName: string) {
  // `border-(--profile-surface)`: the ring follows a surface variable.
  const variable = presenceRingClassName.match(/^border-\((--[\w-]+)\)$/)
  if (variable) return `var(${variable[1]})`
  switch (presenceRingClassName) {
    case 'border-muted':
      return 'var(--muted)'
    case 'border-secondary':
      return 'var(--secondary)'
    case 'border-background':
      return 'var(--background)'
    case 'border-popover':
      return 'var(--popover)'
    default:
      return 'var(--card)'
  }
}

/** Размеры бейджа статуса пропорционально диаметру аватарки (~22–26% × scale). */
export function resolvePresenceBadgeLayout(avatarPx: number): PresenceBadgeLayout {
  const tier =
    PRESENCE_BADGE_TIERS.find((entry) => avatarPx <= entry.maxAvatarPx) ??
    PRESENCE_BADGE_TIERS[PRESENCE_BADGE_TIERS.length - 1]!

  return {
    sizePx: scaledBadgePx(tier.badgePx),
    ringPx: scaledBadgePx(tier.ringPx),
    offsetClass: tier.offsetClass,
  }
}

export function resolvePresenceBadgeLayoutForAvatar(
  ...classNames: Array<string | undefined>
) {
  return resolvePresenceBadgeLayout(resolveAvatarSizePx(...classNames))
}

export type PresenceDotLayout = {
  sizePx: number
  /** Transparent gap cut into the avatar around the dot. */
  gapPx: number
}

/** Discord-like status dot sizes; the dot's centre sits at 85% of the avatar. */
const PRESENCE_DOT_TIERS = [
  { maxAvatarPx: 20, sizePx: 6, gapPx: 1.5 },
  { maxAvatarPx: 28, sizePx: 8, gapPx: 2 },
  { maxAvatarPx: 36, sizePx: 10, gapPx: 3 },
  { maxAvatarPx: 44, sizePx: 12, gapPx: 3 },
  { maxAvatarPx: 56, sizePx: 14, gapPx: 3 },
  { maxAvatarPx: 88, sizePx: 16, gapPx: 4 },
  { maxAvatarPx: Infinity, sizePx: 24, gapPx: 5 },
] as const

export function resolvePresenceDotLayout(avatarPx: number): PresenceDotLayout {
  const tier =
    PRESENCE_DOT_TIERS.find((entry) => avatarPx <= entry.maxAvatarPx) ??
    PRESENCE_DOT_TIERS[PRESENCE_DOT_TIERS.length - 1]
  return { sizePx: tier.sizePx, gapPx: tier.gapPx }
}

export function resolvePresenceDotLayoutForAvatar(
  ...classNames: Array<string | undefined>
) {
  return resolvePresenceDotLayout(resolveAvatarSizePx(...classNames))
}
