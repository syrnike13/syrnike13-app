import { createFileRoute } from '@tanstack/react-router'

import { ServerSettingsPage } from '#/components/servers/server-settings-page'
import { parseServerSettingsTab } from '#/components/servers/server-settings-types'

export const Route = createFileRoute('/app/servers/$serverId/settings')({
  validateSearch: (search: Record<string, unknown>) => ({
    tab: parseServerSettingsTab(search.tab),
  }),
  component: ServerSettingsRoute,
})

function ServerSettingsRoute() {
  const { serverId } = Route.useParams()
  const { tab } = Route.useSearch()

  return <ServerSettingsPage serverId={serverId} tab={tab} />
}
