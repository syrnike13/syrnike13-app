import { createFileRoute } from '@tanstack/react-router'

import { ChannelView } from '#/components/chat/channel-view'

export const Route = createFileRoute('/app/c/$channelId')({
  validateSearch: (search: Record<string, unknown>) => ({
    m: typeof search.m === 'string' ? search.m : undefined,
  }),
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
