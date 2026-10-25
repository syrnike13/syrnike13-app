import type { Server, User } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'

import { serverAcronym } from '#/components/servers/server-avatar'
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from '@syrnike13/ui/primitives/avatar'
import { serverIconUrl } from '#/lib/media'
import { UserAvatar } from '#/components/user/user-avatar'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@syrnike13/ui/primitives/sidebar'
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
    <Tabs defaultValue="servers" className="min-h-0 flex-1 gap-5">
      <TabsList
        variant="line"
        className="w-full shrink-0 justify-start"
      >
        <TabsTrigger value="servers">
          {t('mutualServersCount', { count: mutualServers.length })}
        </TabsTrigger>
        <TabsTrigger value="friends">
          {t('mutualFriendsCount', { count: mutualFriendsCount })}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="servers" className="min-h-0 flex-1 overflow-y-auto">
        {mutualServers.length === 0 ? (
          <Empty size="inline">
            <EmptyDescription>{t('noMutualServers')}</EmptyDescription>
          </Empty>
        ) : (
          <SidebarMenu>
            {mutualServers.map((server) => (
              <SidebarMenuItem key={server._id}>
                <SidebarMenuButton
                  size="lg"
                  disabled={busy}
                  onClick={() => onServerSelect(server._id)}
                >
                  <Avatar>
                    {serverIconUrl(server.icon, { animated: false }) ? (
                      <AvatarImage
                        src={serverIconUrl(server.icon, { animated: false })!}
                        alt=""
                      />
                    ) : null}
                    <AvatarFallback>{serverAcronym(server.name)}</AvatarFallback>
                  </Avatar>
                  <span className="truncate text-foreground">{server.name}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        )}
      </TabsContent>

      <TabsContent value="friends" className="min-h-0 flex-1 overflow-y-auto">
        {mutualFriendsCount === 0 ? (
          <Empty size="inline">
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
