import { useEffect, useState } from 'react'
import type { User } from '@syrnike13/api-types'

import {
  fallbackTilePalette,
  getCachedTilePalette,
  loadAvatarTilePalette,
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

    let active = true
    void loadAvatarTilePalette(avatarId, avatarUrl).then((extracted) => {
      if (!active) return
      setPalette(extracted ?? fallbackTilePalette(seed))
    })

    return () => {
      active = false
    }
  }, [avatarId, avatarUrl, seed])

  return palette
}
