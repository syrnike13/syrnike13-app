import type { Server } from '@syrnike13/api-types'

import { MonitorUpIcon, Volume2BoldIcon } from '#/components/icons'
import { serverIconUrl } from '#/lib/media'
import { cn } from '#/lib/utils'

export type ServerActivityKind = 'voice' | 'screen-share' | null

function ServerActivityBadge({
  kind,
  connected,
}: {
  kind: ServerActivityKind
  connected: boolean
}) {
  if (!kind) return null

  const screenSharing = kind === 'screen-share'
  const label = screenSharing
    ? 'На сервере демонстрируют экран'
    : 'На сервере есть участники голосовых каналов'
  const Icon = screenSharing ? MonitorUpIcon : Volume2BoldIcon

  return (
    <span
      data-slot="server-activity-badge"
      data-kind={kind}
      data-connected={connected ? '' : undefined}
      aria-label={label}
      title={label}
      className={cn(
        'absolute top-0.5 right-0.5 z-10 flex size-3.5 items-center justify-center rounded-full text-background ring-2 ring-background',
        connected ? 'bg-chart-3' : 'bg-muted-foreground',
      )}
    >
      <Icon aria-hidden="true" className="size-2" />
    </span>
  )
}

export function ServerAvatar({
  server,
  animated,
  activity,
  connected,
}: {
  server: Server
  animated: boolean
  activity: ServerActivityKind
  connected: boolean
}) {
  const iconUrl = serverIconUrl(server.icon, { animated })

  return (
    <span className="relative flex size-full items-center justify-center">
      {iconUrl ? (
        <img
          src={iconUrl}
          alt=""
          draggable={false}
          className="size-full object-cover"
        />
      ) : (
        <span className="text-xs font-semibold uppercase">
          {server.name.trim().slice(0, 2) || '??'}
        </span>
      )}
      <ServerActivityBadge kind={activity} connected={connected} />
    </span>
  )
}
