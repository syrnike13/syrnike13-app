import { createFileRoute } from '@tanstack/react-router'

import { ChannelView } from '#/components/chat/channel-view'
import { parseChannelRouteSearch } from '#/lib/channel-settings-navigation'

export const Route = createFileRoute('/app/c/$channelId')({
  validateSearch: (search: Record<string, unknown>) =>
    parseChannelRouteSearch(search),
  component: ChannelRoute,
})

function ChannelRoute() {
  const { channelId } = Route.useParams()
  const { m: highlightMessageId } = Route.useSearch()
  return (
    <ChannelView
      channelId={channelId}
      highlightMessageId={highlightMessageId}
    />
  )
}
