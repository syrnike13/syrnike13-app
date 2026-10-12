import { useEffect, useState } from 'react'
import type { User } from '@syrnike13/api-types'
import { Effect, Fiber } from 'effect'

import {
  fallbackTilePalette,
  getCachedTilePalette,
  loadAvatarTilePaletteEffect,
  type TilePalette,
} from '#/lib/avatar-tile-palette'
import { userAvatarUrl } from '#/lib/media'

export function useVoiceTilePalette(
  user: User | undefined,
  participantId: string,
) {
  const seed = user?._id ?? participantId
  const avatarId = user?.avatar?._id
  const avatarUrl = user ? userAvatarUrl(user.avatar) : null

  const [palette, setPalette] = useState<TilePalette>(() => {
    if (avatarId) {
      const cached = getCachedTilePalette(avatarId)
      if (cached) return cached
    }
    return fallbackTilePalette(seed)
  })

  useEffect(() => {
    if (!avatarUrl || !avatarId) {
      setPalette(fallbackTilePalette(seed))
      return
    }

    const cached = getCachedTilePalette(avatarId)
    if (cached) {
      setPalette(cached)
      return
    }

    const fiber = Effect.runFork(
      loadAvatarTilePaletteEffect(avatarId, avatarUrl).pipe(
        Effect.tap((extracted) =>
          Effect.sync(() => {
            setPalette(extracted ?? fallbackTilePalette(seed))
          }),
        ),
        Effect.ignore,
      ),
    )

    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [avatarId, avatarUrl, seed])

  return palette
}
