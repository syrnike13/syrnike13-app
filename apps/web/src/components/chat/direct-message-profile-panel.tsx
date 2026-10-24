import type { User } from '@syrnike13/api-types'
import { useLocale, useTranslations } from '@syrnike13/ui/i18n'

import { FloatingBarShell } from '#/components/layout/floating-bar-shell'
import { UserProfileHeader } from '#/components/user/user-profile-header'
import { UserProfileIdentity } from '#/components/user/user-profile-identity'
import { useUserMutuals } from '#/components/user/use-user-mutuals'
import { useUserProfileData } from '#/components/user/use-user-profile-data'
import { Button } from '@syrnike13/ui/primitives/button'
import { ScrollArea } from '@syrnike13/ui/primitives/scroll-area'
import { useMutualServerMembersSync } from '#/features/sync/mutual-server-members-sync'
import { ulidToDate } from '#/lib/ulid'

type DirectMessageProfilePanelProps = {
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
    <aside aria-label={t('profileLabel')} className="hidden w-85 shrink-0 py-2 pr-2 lg:flex">
      <FloatingBarShell className="flex min-h-0 w-full" surfaceClassName="h-full">
        <div className="flex h-full min-h-0 flex-col">
          <ScrollArea className="min-h-0 flex-1">
            <UserProfileHeader user={user} variant="panel" onAvatarClick={onOpenProfile} />
            <div className="flex flex-col gap-4 px-4 pt-1 pb-4">
              <div className="flex flex-col gap-2">
                <UserProfileIdentity user={user} />
                {mutuals.length > 0 ? (
                  <p className="text-sm text-muted-foreground">{mutuals.join(' • ')}</p>
                ) : null}
              </div>
              {bio ? <p className="text-sm whitespace-pre-wrap">{bio}</p> : null}
              {aliases.length > 0 ? (
                <section className="flex flex-col gap-1">
                  <h3 className="text-xs font-semibold">{tu('aka')}</h3>
                  <p className="truncate text-sm">{aliases.join(', ')}</p>
                </section>
              ) : null}
              <section className="flex flex-col gap-1">
                <h3 className="text-xs font-semibold">{tu('memberSince')}</h3>
                <p className="text-sm">{memberSince}</p>
              </section>
            </div>
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
