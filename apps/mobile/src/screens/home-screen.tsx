import { useSyncStore } from '@syrnike13/client/sync/sync-store'
import { View } from 'react-native'

import { ServerRail } from '../components/server-rail'
import { UserBar } from '../components/user-bar'
import { DirectMessagesPanel } from './direct-messages-panel'
import { ServerPanel } from './server-panel'

/**
 * Discord mobile shell: the server rail on the left, the selected server's
 * channels (or the DM home) in the rounded panel, the user card floating on top.
 */
export function HomeScreen() {
  const serverId = useSyncStore((state) => state.selectedServerId)
  const server = useSyncStore((state) => (serverId ? state.servers[serverId] : undefined))

  return (
    <View className="flex-1 flex-row bg-background">
      <ServerRail />
      <View className="flex-1 overflow-hidden rounded-tl-2xl bg-card">
        {server ? <ServerPanel server={server} /> : <DirectMessagesPanel />}
      </View>
      <UserBar />
    </View>
  )
}
