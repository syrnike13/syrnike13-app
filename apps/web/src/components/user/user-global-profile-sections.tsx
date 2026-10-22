import { ServerIcon } from '#/components/icons'
import type { Server, User } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'

import { UserAvatar } from '#/components/user/user-avatar'
import { Empty, EmptyDescription } from '@syrnike13/ui/primitives/empty'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@syrnike13/ui/primitives/tabs'

type UserGlobalProfileSectionsProps = {
  mutualServers: Server[]
  mutualFriends: User[]
  mutualFriendsCount: number
  busy: boolean
  onServerSelect: (serverId: string) => void
}

export function UserGlobalProfileSections({
  mutualServers,
  mutualFriends,
  mutualFriendsCount,
  busy,
  onServerSelect,
}: UserGlobalProfileSectionsProps) {
  const t = useTranslations('users')

  return (
    <Tabs defaultValue="servers" className="min-h-0 flex-1 gap-0">
      <TabsList
        variant="line"
        className="w-full shrink-0 justify-start gap-6"
      >
        <TabsTrigger
          value="servers"
          className="flex-none px-0 text-base font-medium"
        >
          {t('mutualServersCount', { count: mutualServers.length })}
        </TabsTrigger>
        <TabsTrigger
          value="friends"
          className="flex-none px-0 text-base font-medium"
        >
          {t('mutualFriendsCount', { count: mutualFriendsCount })}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="servers" className="min-h-0 flex-1 overflow-y-auto pt-5">
        {mutualServers.length === 0 ? (
          <Empty className="items-start p-0 text-left">
            <EmptyDescription>{t('noMutualServers')}</EmptyDescription>
          </Empty>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {mutualServers.map((server) => (
              <li key={server._id}>
                <button
                  type="button"
                  disabled={busy}
                  className="flex min-h-10.5 w-full min-w-0 items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
                  onClick={() => onServerSelect(server._id)}
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                    <ServerIcon className="size-4" />
                  </span>
                  <span className="min-w-0 truncate text-base leading-5 font-medium">
                    {server.name}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </TabsContent>

      <TabsContent value="friends" className="min-h-0 flex-1 overflow-y-auto pt-5">
        {mutualFriendsCount === 0 ? (
          <Empty className="items-start p-0 text-left">
            <EmptyDescription>{t('noMutualFriends')}</EmptyDescription>
          </Empty>
        ) : mutualFriends.length === 0 ? (
          <p className="text-sm leading-4.5 text-muted-foreground">
            {t('mutualFriendsCount', { count: mutualFriendsCount })}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {mutualFriends.map((friend) => (
              <li
                key={friend._id}
                className="flex min-h-10.5 min-w-0 items-center gap-3 rounded-lg px-2 py-1.5"
              >
                <UserAvatar
                  user={friend}
                  className="size-8"
                  fallbackClassName="size-8 text-sm"
                  showPresence={false}
                  animated="never"
                />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-base leading-5 font-medium">
                    {friend.display_name ?? friend.username}
                  </span>
                  <span className="truncate text-sm leading-4.5 text-muted-foreground">
                    @{friend.username}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </TabsContent>
    </Tabs>
  )
}
