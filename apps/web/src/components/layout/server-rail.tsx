import { Link, useMatch } from '@tanstack/react-router'
import { CompassIcon, HashIcon, HomeIcon } from 'lucide-react'
import type { Server } from '@syrnike13/api-types'

import { Button } from '#/components/ui/button'
import { ScrollArea } from '#/components/ui/scroll-area'
import { CreateServerDialog } from '#/components/servers/create-server-dialog'
import { listServerChannels, listServers } from '#/features/sync/selectors'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { USER_PANEL_RESERVE_PX } from '#/components/layout/left-sidebar-stack'
import {
  railIconButtonClass,
  railIconIdleClass,
  shellNavSurface,
} from '#/components/layout/shell-chrome'
import { cn } from '#/lib/utils'

function railButtonClass(active: boolean) {
  return cn(railIconButtonClass, !active && railIconIdleClass)
}

function ServerRailButton({ server }: { server: Server }) {
  const selectedServerId = useSyncStore((s) => s.selectedServerId)
  const firstChannelId = useSyncStore((s) => {
    const channels = listServerChannels(s, server._id)
    const text = channels.find((c) => c.channel_type === 'TextChannel')
    return (text ?? channels[0])?._id
  })

  const homeMatch = useMatch({
    from: '/app/',
    shouldThrow: false,
  })
  const discoverMatch = useMatch({
    from: '/app/discover',
    shouldThrow: false,
  })
  const channelMatch = useMatch({
    from: '/app/c/$channelId',
    shouldThrow: false,
  })
  const active =
    Boolean(channelMatch) &&
    !discoverMatch &&
    !homeMatch &&
    selectedServerId === server._id

  const content = <ServerInitial name={server.name} />

  if (firstChannelId) {
    return (
      <Button
        size="icon"
        variant={active ? 'default' : 'ghost'}
        className={railButtonClass(active)}
        title={server.name}
        asChild
      >
        <Link
          to="/app/c/$channelId"
          params={{ channelId: firstChannelId }}
        >
          {content}
        </Link>
      </Button>
    )
  }

  return (
    <Button
      size="icon"
      variant={active ? 'default' : 'ghost'}
      className={railButtonClass(active)}
      title={server.name}
      asChild
    >
      <Link
        to="/app"
        onClick={() => syncStore.setSelectedServerId(server._id)}
      >
        {content}
      </Link>
    </Button>
  )
}

function ServerInitial({ name }: { name: string }) {
  return (
    <span className="text-xs font-semibold uppercase">
      {name.trim().slice(0, 2) || '??'}
    </span>
  )
}

export function ServerRail() {
  const ready = useSyncStore((s) => s.ready)
  const selectedServerId = useSyncStore((s) => s.selectedServerId)
  const servers = useSyncStore(listServers)

  const homeMatch = useMatch({
    from: '/app/',
    shouldThrow: false,
  })
  const discoverMatch = useMatch({
    from: '/app/discover',
    shouldThrow: false,
  })
  const channelMatch = useMatch({
    from: '/app/c/$channelId',
    shouldThrow: false,
  })

  const homeActive =
    Boolean(homeMatch) && !discoverMatch && !channelMatch

  if (!ready) {
    return (
      <div
        className={`flex h-full w-14 shrink-0 flex-col items-center py-3 ${shellNavSurface}`}
        style={{ paddingBottom: USER_PANEL_RESERVE_PX }}
      >
        <div className={cn(railIconButtonClass, 'animate-pulse bg-muted')} />
      </div>
    )
  }

  return (
    <div
      className={`flex h-full w-14 shrink-0 flex-col items-center gap-2 py-3 ${shellNavSurface}`}
      style={{ paddingBottom: USER_PANEL_RESERVE_PX }}
    >
      <Button
        size="icon"
        variant={homeActive ? 'default' : 'ghost'}
        className={railButtonClass(homeActive)}
        title="Главная"
        asChild
      >
        <Link
          to="/app"
          search={{ tab: 'online' }}
          onClick={() => syncStore.setSelectedServerId(null)}
        >
          <HomeIcon />
        </Link>
      </Button>

      <ScrollArea className="min-h-0 w-full flex-1 px-2">
        <div className="flex flex-col items-center gap-2">
          {servers.map((server) => (
            <ServerRailButton key={server._id} server={server} />
          ))}
          {servers.length === 0 ? (
            <div
              className={cn(
                railIconButtonClass,
                railIconIdleClass,
                'flex items-center justify-center text-foreground',
              )}
              title="Нет серверов"
            >
              <HashIcon className="size-4" />
            </div>
          ) : null}

          <CreateServerDialog />

          <Button
            size="icon"
            variant={discoverMatch ? 'default' : 'ghost'}
            className={railButtonClass(Boolean(discoverMatch))}
            title="Поиск серверов"
            asChild
          >
            <Link to="/app/discover">
              <CompassIcon />
            </Link>
          </Button>
        </div>
      </ScrollArea>
    </div>
  )
}
