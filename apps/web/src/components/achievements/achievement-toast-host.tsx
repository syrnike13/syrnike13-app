import { Award } from 'lucide-react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { useAuth } from '#/features/auth/auth-context'
import {
  achievementQueue,
  useCurrentAchievement,
  type AchievementUnlock,
} from '#/features/achievements/achievement-queue'
import {
  acknowledgeAchievement,
  useAchievementUnlocks,
} from '#/features/achievements/use-achievement-unlocks'

const VISIBLE_MS = 6000
const EXIT_MS = 360

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
      className="achievement-toast pointer-events-auto flex w-full items-center gap-3 overflow-hidden rounded-md border border-border bg-popover p-2.5 text-left text-popover-foreground shadow-2xl sm:w-80"
    >
      <span className="relative flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-muted ring-1 ring-border">
        {unlock.iconUrl ? (
          <img
            src={unlock.iconUrl}
            alt=""
            className="size-full object-contain p-1"
            draggable={false}
          />
        ) : (
          <Award className="size-9 text-primary" aria-hidden />
        )}
        <span className="achievement-toast-shine" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
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
