import { createFileRoute } from '@tanstack/react-router'

import { ServerSettingsPage } from '#/components/servers/server-settings-page'
import { parseServerSettingsTab } from '#/components/servers/server-settings-types'

export const Route = createFileRoute('/m/servers/$serverId/settings')({
  validateSearch: (search: Record<string, unknown>) => ({
    tab: parseServerSettingsTab(search.tab),
  }),
  component: MobileServerSettingsRoute,
})

function MobileServerSettingsRoute() {
  const { serverId } = Route.useParams()
  const { tab } = Route.useSearch()

  return <ServerSettingsPage serverId={serverId} tab={tab} />
}
