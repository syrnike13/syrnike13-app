import { useLocalSearchParams } from 'expo-router'

import { ChatScreen } from '../../screens/chat-screen'

export default function ChannelRoute() {
  const { channelId } = useLocalSearchParams<{ channelId: string }>()
  return <ChatScreen key={channelId} channelId={channelId} />
}
