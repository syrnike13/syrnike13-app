import { ServerIcon } from '#/components/icons'
import type { Server } from '@syrnike13/api-types'
import { useState } from 'react'

import { cn } from '#/lib/utils'

type GlobalProfileSection = 'mutual-servers'

type UserGlobalProfileSectionsProps = {
  mutualServers: Server[]
  busy: boolean
  onServerSelect: (serverId: string) => void
}

export function UserGlobalProfileSections({
  mutualServers,
  busy,
  onServerSelect,
}: UserGlobalProfileSectionsProps) {
  const [section, setSection] = useState<GlobalProfileSection>('mutual-servers')

  const tabs: { id: GlobalProfileSection; label: string }[] = [
    {
      id: 'mutual-servers',
      label: `Общие серверы — ${mutualServers.length}`,
    },
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="tablist"
        className="flex shrink-0 gap-4 overflow-x-auto border-b border-border px-4"
      >
        {tabs.map((tab) => {
          const active = section === tab.id
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={cn(
                'shrink-0 border-b-2 py-3 text-sm font-medium transition-colors',
                active
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
              onClick={() => setSection(tab.id)}
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {section === 'mutual-servers' ? (
          mutualServers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Нет общих серверов.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {mutualServers.map((server) => (
                <li key={server._id}>
                  <button
                    type="button"
                    disabled={busy}
                    className="flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                    onClick={() => onServerSelect(server._id)}
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                      <ServerIcon className="size-5" />
                    </span>
                    <span className="min-w-0 truncate font-medium">
                      {server.name}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </div>
    </div>
  )
}
