import type { User } from '@syrnike13/api-types'
import { useLocale, useTranslations } from '@syrnike13/ui/i18n'
import type { ReactNode } from 'react'

import { ChevronRightIcon } from '#/components/icons'
import { ServerAvatar } from '#/components/servers/server-avatar'
import { UserAvatar } from '#/components/user/user-avatar'
import { UserProfileHeader } from '#/components/user/user-profile-header'
import { UserProfileIdentity } from '#/components/user/user-profile-identity'
import { useUserMutuals } from '#/components/user/use-user-mutuals'
import { useUserProfileData } from '#/components/user/use-user-profile-data'
import { Button } from '@syrnike13/ui/primitives/button'
import { Card, CardContent } from '@syrnike13/ui/primitives/card'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@syrnike13/ui/primitives/collapsible'
import { Item, ItemContent, ItemMedia, ItemTitle } from '@syrnike13/ui/primitives/item'
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

function ProfileSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}

function MutualList({ title, empty, children }: { title: string; empty: boolean; children: ReactNode }) {
  return (
    <Collapsible>
      <CollapsibleTrigger
        render={<Button type="button" variant="ghost" className="group w-full justify-between" />}
      >
        {title}
        <ChevronRightIcon className="text-muted-foreground transition-transform group-data-panel-open:rotate-90" />
      </CollapsibleTrigger>
      {!empty ? (
        <CollapsibleContent>
          <ul className="flex flex-col">{children}</ul>
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  )
}

/** Discord-style DM side panel: fixed 340px column with the recipient's profile. */
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
  const memberSince = ulidToDate(user._id).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })

  return (
    <aside
      aria-label={t('profileLabel')}
      className="theme-surface-content gradient-surface-content hidden w-85 shrink-0 flex-col border-l border-shell-divider text-card-foreground lg:flex"
    >
      <ScrollArea className="min-h-0 flex-1">
        <UserProfileHeader user={user} variant="panel" onAvatarClick={onOpenProfile} />

        <div className="flex flex-col gap-3 px-4 pt-1 pb-4">
          <UserProfileIdentity user={user} />

          <Card size="sm">
            <CardContent className="flex flex-col gap-3">
              {bio ? (
                <ProfileSection title={t('about')}>
                  <p className="text-sm whitespace-pre-wrap">{bio}</p>
                </ProfileSection>
              ) : null}
              {aliases.length > 0 ? (
                <ProfileSection title={tu('aka')}>
                  <p className="truncate text-sm">{aliases.join(', ')}</p>
                </ProfileSection>
              ) : null}
              <ProfileSection title={tu('memberSince')}>
                <p className="text-sm">{memberSince}</p>
              </ProfileSection>
            </CardContent>
          </Card>

          <Card size="sm">
            <CardContent className="flex flex-col">
              <MutualList
                title={tu('mutualServersCount', { count: mutualServers.length })}
                empty={mutualServers.length === 0}
              >
                {mutualServers.map((server) => (
                  <Item key={server._id} size="xs" render={<li />}>
                    <ItemMedia>
                      <span className="flex size-6 overflow-hidden rounded-md bg-muted">
                        <ServerAvatar server={server} animated={false} activity={null} connected={false} />
                      </span>
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{server.name}</ItemTitle>
                    </ItemContent>
                  </Item>
                ))}
              </MutualList>
              <MutualList
                title={tu('mutualFriendsCount', { count: mutualFriends.length })}
                empty={mutualFriends.length === 0}
              >
                {mutualFriends.map((friend) => (
                  <Item key={friend._id} size="xs" render={<li />}>
                    <ItemMedia>
                      <UserAvatar user={friend} className="size-6" fallbackClassName="size-6 text-xs" />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{friend.display_name ?? friend.username}</ItemTitle>
                    </ItemContent>
                  </Item>
                ))}
              </MutualList>
            </CardContent>
          </Card>

          {onOpenProfile ? (
            <Button type="button" variant="secondary" className="w-full" onClick={onOpenProfile}>
              {tu('viewFullProfile')}
            </Button>
          ) : null}
        </div>
      </ScrollArea>
    </aside>
  )
}
