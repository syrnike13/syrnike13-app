import type { User } from '@syrnike13/api-types'
import { useLocale, useTranslations } from '@syrnike13/ui/i18n'

import { FloatingBarShell } from '#/components/layout/floating-bar-shell'
import {
  ProfileBody,
  ProfileHeader,
  ProfileName,
  ProfileSection,
  ProfileSurface,
} from '#/components/user/profile/profile-parts'
import { useUserMutuals } from '#/components/user/use-user-mutuals'
import { useUserProfileData } from '#/components/user/use-user-profile-data'
import { Button } from '@syrnike13/ui/primitives/button'
import { ScrollArea } from '@syrnike13/ui/primitives/scroll-area'
import { useMutualServerMembersSync } from '#/features/sync/mutual-server-members-sync'
import { ulidToDate } from '#/lib/ulid'
import { cn } from '#/lib/utils'

type DirectMessageProfilePanelProps = {
  /** Closed panels stay mounted and collapse to zero width, so they can animate. */
  open: boolean
  user: User
  currentUserId?: string
  token?: string | null
  aliases: string[]
  onOpenProfile?: () => void
}

/**
 * Discord-style DM profile: a floating 340px panel beside the chat with the
 * full profile button pinned to its bottom.
 */
export function DirectMessageProfilePanel({
  open,
  user,
  currentUserId,
  token,
  aliases,
  onOpenProfile,
}: DirectMessageProfilePanelProps) {
  const t = useTranslations('chat')
  const tu = useTranslations('users')
  const { locale } = useLocale()
  useMutualServerMembersSync(user._id, currentUserId, token)
  const { bio } = useUserProfileData(user._id)
  const { mutualServers, mutualFriends } = useUserMutuals(user._id)
  const mutuals = [
    mutualFriends.length > 0 ? tu('mutualFriendsShort', { count: mutualFriends.length }) : null,
    mutualServers.length > 0 ? tu('mutualServersShort', { count: mutualServers.length }) : null,
  ].filter(Boolean)
  const memberSince = ulidToDate(user._id).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })

  return (
    <aside
      aria-label={t('profileLabel')}
      aria-hidden={!open}
      inert={!open}
      data-state={open ? 'open' : 'closed'}
      className={cn(
        'hidden shrink-0 overflow-hidden transition-[width] duration-300 ease-out-expo motion-reduce:transition-none lg:flex',
        open ? 'w-85' : 'w-0',
      )}
    >
      <FloatingBarShell
        className={cn(
          'flex min-h-0 w-85 shrink-0 py-2 pr-2 transition-[opacity,translate] duration-300 ease-out-expo motion-reduce:transition-none',
          open ? 'translate-x-0 opacity-100' : 'translate-x-6 opacity-0',
        )}
        surfaceClassName="h-full"
      >
        <div className="flex h-full min-h-0 flex-col">
          <ScrollArea className="min-h-0 flex-1">
            <ProfileSurface surface="secondary">
              <ProfileHeader user={user} onAvatarClick={onOpenProfile} />
              <ProfileBody>
                <div className="flex flex-col gap-2">
                  <ProfileName user={user} />
                  {mutuals.length > 0 ? (
                    <p className="text-sm text-muted-foreground">{mutuals.join(' • ')}</p>
                  ) : null}
                </div>
                {bio ? (
                  <ProfileSection title={tu('aboutMe')}>
                    <p className="whitespace-pre-wrap">{bio}</p>
                  </ProfileSection>
                ) : null}
                {aliases.length > 0 ? (
                  <ProfileSection title={tu('aka')}>
                    <p className="truncate">{aliases.join(', ')}</p>
                  </ProfileSection>
                ) : null}
                <ProfileSection title={tu('accountCreated')}>
                  <p>{memberSince}</p>
                </ProfileSection>
              </ProfileBody>
            </ProfileSurface>
          </ScrollArea>
          {onOpenProfile ? (
            <div className="p-4 pt-2">
              <Button type="button" variant="outline" size="lg" className="w-full" onClick={onOpenProfile}>
                {tu('viewFullProfile')}
              </Button>
            </div>
          ) : null}
        </div>
      </FloatingBarShell>
    </aside>
  )
}
