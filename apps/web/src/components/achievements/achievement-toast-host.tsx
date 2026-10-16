import {
  Award,
  Bomb,
  Crown,
  Gamepad,
  Gamepad2,
  Ghost,
  Heart,
  Joystick,
  Rocket,
  Star,
  Sword,
  Trophy,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'

import { useAuth } from '#/features/auth/auth-context'
import { useAchievementIconTone } from '#/features/achievements/achievement-icon-tone'
import {
  achievementQueue,
  useCurrentAchievement,
  type AchievementUnlock,
} from '#/features/achievements/achievement-queue'
import {
  acknowledgeAchievement,
  useAchievementUnlocks,
} from '#/features/achievements/use-achievement-unlocks'
import { cn } from '#/lib/utils'

const VISIBLE_MS = 6000
const EXIT_MS = 360

const WALLPAPER_ICONS: LucideIcon[] = [
  Gamepad2,
  Joystick,
  Ghost,
  Trophy,
  Gamepad,
  Sword,
  Heart,
  Star,
  Zap,
  Crown,
  Bomb,
  Rocket,
]
/** Ячейка узора 120×80: [x, y, размер]; узор сдвигается ровно на одну ячейку. */
const WALLPAPER_CELL = [
  [12, 10, 22],
  [64, 6, 16],
  [38, 44, 18],
  [92, 40, 24],
  [10, 58, 14],
  [70, 62, 15],
] as const
const WALLPAPER_COLUMNS = 4
const WALLPAPER_ROWS = 3

const RAY_COUNT = 44

type Ray = {
  angle: number
  width: number
  length: number
  style: CSSProperties
}

function random(min: number, max: number) {
  return min + Math.random() * (max - min)
}

function createRays(): Ray[] {
  return Array.from({ length: RAY_COUNT }, (_, index) => ({
    angle: (index * 360) / RAY_COUNT + random(-3, 3),
    width: random(1.2, 2.4),
    length: random(9, 15),
    style: {
      '--ray-x1': random(0.5, 1.3).toFixed(2),
      '--ray-y1': random(0.55, 1).toFixed(2),
      '--ray-x2': random(0.6, 1.5).toFixed(2),
      '--ray-y2': random(0.65, 1.15).toFixed(2),
      '--ray-x3': random(0.4, 1.2).toFixed(2),
      '--ray-y3': random(0.55, 0.95).toFixed(2),
      '--ray-duration': `${random(1.2, 2.8).toFixed(2)}s`,
      '--ray-delay': `${(-random(0, 3)).toFixed(2)}s`,
    } as CSSProperties,
  }))
}

/** Уведомления о новых бейджах в стиле Steam: по одному, снизу справа. */
export function AchievementToastHost() {
  useAchievementUnlocks()
  const current = useCurrentAchievement()

  if (typeof document === 'undefined' || !current) return null

  return createPortal(
    <div className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex justify-end sm:inset-x-auto sm:right-4">
      <AchievementToast key={current.id} unlock={current} />
    </div>,
    document.body,
  )
}

function AchievementToast({ unlock }: { unlock: AchievementUnlock }) {
  const token = useAuth().session?.token
  const [exiting, setExiting] = useState(false)

  useEffect(() => {
    if (token && unlock.badgeId) acknowledgeAchievement(token, unlock.badgeId)
  }, [token, unlock.badgeId])

  useEffect(() => {
    const timer = window.setTimeout(
      () => (exiting ? achievementQueue.advance() : setExiting(true)),
      exiting ? EXIT_MS : VISIBLE_MS,
    )
    return () => window.clearTimeout(timer)
  }, [exiting])

  return (
    <button
      type="button"
      role="status"
      aria-live="polite"
      data-phase={exiting ? 'exiting' : 'visible'}
      onClick={() => setExiting(true)}
      className="achievement-toast pointer-events-auto relative flex w-full items-center gap-5 overflow-hidden rounded-md border border-border bg-popover py-4 pr-3.5 pl-5 text-left text-popover-foreground shadow-2xl sm:w-[21rem]"
    >
      <AchievementWallpaper />
      <AchievementBadgeIcon iconUrl={unlock.iconUrl} />
      <span className="relative min-w-0 flex-1">
        <span className="block truncate text-sm leading-tight font-semibold">
          {unlock.name}
        </span>
        <span className="mt-1 line-clamp-2 text-xs leading-snug text-muted-foreground">
          {unlock.description ?? 'Новый бейдж в вашем профиле.'}
        </span>
      </span>
    </button>
  )
}

function AchievementWallpaper() {
  const tiles = []
  for (let column = 0; column < WALLPAPER_COLUMNS; column++) {
    for (let row = 0; row < WALLPAPER_ROWS; row++) {
      for (const [index, [x, y, size]] of WALLPAPER_CELL.entries()) {
        const Icon =
          WALLPAPER_ICONS[(index * 3 + column + row * 2) % WALLPAPER_ICONS.length]!
        tiles.push(
          <Icon
            key={`${column}-${row}-${index}`}
            className="absolute text-muted-foreground opacity-15"
            style={{
              left: column * 120 + x,
              top: row * 80 + y,
              width: size,
              height: size,
              rotate: `${((index * 37) % 50) - 25}deg`,
            }}
          />,
        )
      }
    }
  }

  return (
    <span className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      <span className="achievement-wallpaper">{tiles}</span>
    </span>
  )
}

function AchievementBadgeIcon({ iconUrl }: { iconUrl: string | null }) {
  const [rays] = useState(createRays)
  const toned = useAchievementIconTone(iconUrl)
  const icon = toned ?? (toned === null && iconUrl ? { src: iconUrl, pixelated: true } : null)

  return (
    <span className="relative size-16 shrink-0" aria-hidden>
      <span className="achievement-rays">
        {rays.map((ray, index) => (
          <span
            key={index}
            className="achievement-ray"
            style={{ transform: `rotate(${ray.angle}deg) translateY(28px)` }}
          >
            <span
              style={{
                ...ray.style,
                width: ray.width,
                height: ray.length,
                marginLeft: -ray.width / 2,
              }}
            />
          </span>
        ))}
      </span>
      <span className="achievement-frame">
        <span className="relative flex size-full items-center justify-center overflow-hidden rounded-[3px] bg-muted">
          {icon ? (
            <img
              src={icon.src}
              alt=""
              draggable={false}
              className={cn(
                'size-full object-contain',
                icon.pixelated && '[image-rendering:pixelated]',
              )}
            />
          ) : iconUrl ? null : (
            <Award className="size-9 text-achievement" />
          )}
        </span>
      </span>
    </span>
  )
}
