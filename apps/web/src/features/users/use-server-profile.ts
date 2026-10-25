import type { ProfileColours } from '@syrnike13/api-types'

import { useSyncStore } from '#/features/sync/sync-store'
import { userAvatarUrl, userBannerUrl } from '#/lib/media'

export type ServerProfile = {
  nickname: string | null
  avatarUrl: string | null
  bannerUrl: string | null
  bio: string | null
  colours: ProfileColours | null
}

/**
 * The member's profile on one server. Every field is null when the member
 * did not set it, so callers fall back to the global profile.
 */
export function useServerProfile(
  serverId: string | undefined,
  userId: string,
): ServerProfile | null {
  const member = useSyncStore((state) =>
    serverId ? state.members[`${serverId}:${userId}`] : undefined,
  )
  if (!member) return null

  return {
    nickname: member.nickname?.trim() || null,
    avatarUrl: member.avatar
      ? userAvatarUrl(member.avatar, { animated: true })
      : null,
    bannerUrl: member.banner
      ? userBannerUrl(member.banner, { animated: true })
      : null,
    bio: member.bio?.trim() || null,
    colours: member.colours ?? null,
  }
}
