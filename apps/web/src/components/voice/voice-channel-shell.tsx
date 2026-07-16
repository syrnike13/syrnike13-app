import { useEffect, useState } from 'react'

import { ChannelChatPanel } from '#/components/chat/channel-chat-panel'
import { VoiceStageView } from '#/components/voice/voice-stage-view'
import { useAuth } from '#/features/auth/auth-context'
import { getChannelLabel } from '#/features/sync/channel-label'
import { useSyncStore } from '#/features/sync/sync-store'
import {
  consumeVoiceChannelChatOpenRequest,
  subscribeVoiceChannelChatOpen,
} from '#/features/voice/voice-channel-chat-intent'
import {
  isServerVoiceChannel,
  type RuntimeChannel,
} from '#/lib/channel-voice'
import { cn } from '#/lib/utils'

type VoiceChannelShellProps = {
  channelId: string
  highlightMessageId?: string
}

export function VoiceChannelShell({
  channelId,
  highlightMessageId,
}: VoiceChannelShellProps) {
  const auth = useAuth()
  const channel = useSyncStore((s) => s.channels[channelId])
  const users = useSyncStore((s) => s.users)
  const [chatOpen, setChatOpen] = useState(() =>
    consumeVoiceChannelChatOpenRequest(channelId),
  )

  useEffect(() => {
    if (consumeVoiceChannelChatOpenRequest(channelId)) {
      setChatOpen(true)
    }

    return subscribeVoiceChannelChatOpen((requestedChannelId) => {
      if (requestedChannelId !== channelId) return
      consumeVoiceChannelChatOpenRequest(channelId)
      setChatOpen(true)
    })
  }, [channelId])
  const runtimeChannel = channel as RuntimeChannel | undefined

  if (!channel) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        Канал не найден
      </div>
    )
  }

  if (
    !runtimeChannel ||
    (!isServerVoiceChannel(runtimeChannel) &&
      channel.channel_type !== 'DirectMessage' &&
      channel.channel_type !== 'Group')
  ) {
    return null
  }

  const title = getChannelLabel(channel, users, auth.user?._id)

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <VoiceStageView
        channel={channel}
        title={title}
        chatOpen={chatOpen}
        onToggleChat={() => setChatOpen((open) => !open)}
      />
      <div
        className={cn(
          'flex min-h-0 shrink-0 overflow-hidden transition-[width] duration-200 ease-out',
          chatOpen ? 'w-[min(420px,40vw)]' : 'w-0',
        )}
      >
        {chatOpen ? (
          <ChannelChatPanel
            key={channelId}
            channelId={channelId}
            highlightMessageId={highlightMessageId}
            onClose={() => setChatOpen(false)}
          />
        ) : null}
      </div>
    </div>
  )
}
