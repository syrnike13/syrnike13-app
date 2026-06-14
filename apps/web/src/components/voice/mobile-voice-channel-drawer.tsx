import { useEffect, useState } from 'react'

import { ChannelChatPanel } from '#/components/chat/channel-chat-panel'
import { Drawer, DrawerContent } from '#/components/ui/drawer'
import { VoiceStageView } from '#/components/voice/voice-stage-view'
import { useMobileVoiceChannelDrawer } from '#/features/navigation/mobile-voice-channel-drawer-context'
import { useAuth } from '#/features/auth/auth-context'
import { getChannelLabel } from '#/features/sync/channel-label'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { useVoice } from '#/features/voice/voice-context'
import { isVoiceSessionInChannel } from '#/features/voice/voice-mic-status'
import { isServerVoiceChannel } from '#/lib/channel-voice'
import { cn } from '#/lib/utils'

/**
 * Drawer голосового канала для мобильной оболочки.
 *
 * Монтируется только из `m/route.tsx`, поэтому guard `useIsCompact` не нужен —
 * в десктопной зоне `/app` компонент не появляется.
 */
export function MobileVoiceChannelDrawer() {
  const auth = useAuth()
  const voice = useVoice()
  const { channelId, openVoiceChannelDrawer, closeVoiceChannelDrawer } =
    useMobileVoiceChannelDrawer()
  const channel = useSyncStore((s) =>
    channelId ? s.channels[channelId] : undefined,
  )
  const users = useSyncStore((s) => s.users)
  const [chatOpen, setChatOpen] = useState(false)

  const open = Boolean(channelId && channel && isServerVoiceChannel(channel))
  const inThisChannel = Boolean(
    channel && isVoiceSessionInChannel(voice, channel._id),
  )
  const voiceActive =
    inThisChannel &&
    (voice.status === 'connected' || voice.status === 'connecting')
  const fullscreen = voiceActive

  useEffect(() => {
    if (!voice.channelId) return
    if (voice.status !== 'connected' && voice.status !== 'connecting') return

    const activeChannel = syncStore.getState().channels[voice.channelId]
    if (!activeChannel || !isServerVoiceChannel(activeChannel)) return

    openVoiceChannelDrawer(voice.channelId)
  }, [openVoiceChannelDrawer, voice.channelId, voice.status])

  useEffect(() => {
    if (!open) {
      setChatOpen(false)
    }
  }, [open])

  const title =
    channel && auth.user
      ? getChannelLabel(channel, users, auth.user._id)
      : 'Голосовой канал'

  return (
    <Drawer
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeVoiceChannelDrawer()
      }}
    >
      <DrawerContent
        showHandle={!fullscreen}
        className={cn(
          fullscreen
            ? 'inset-0 top-0 h-[100dvh] max-h-[100dvh] rounded-none border-0 pb-0'
            : 'h-[min(85dvh,720px)] max-h-[min(92dvh,820px)]',
          'flex flex-col gap-0 overflow-hidden p-0',
        )}
      >
        {channel && isServerVoiceChannel(channel) ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div
              className={cn(
                'flex min-h-0 flex-col overflow-hidden',
                chatOpen && !fullscreen
                  ? 'h-[min(52dvh,420px)] shrink-0'
                  : 'min-h-0 flex-1',
                fullscreen && !chatOpen && 'min-h-0 flex-1',
                fullscreen && chatOpen && 'h-[55%] shrink-0',
              )}
            >
              <VoiceStageView
                channel={channel}
                title={title}
                chatOpen={chatOpen}
                onToggleChat={() => setChatOpen((value) => !value)}
                mobileDrawer
                joinButtonLabel="Войти в голос"
                onClose={closeVoiceChannelDrawer}
              />
            </div>
            {chatOpen ? (
              <div
                className={cn(
                  'flex min-h-0 flex-col border-t border-shell-divider bg-background',
                  fullscreen ? 'flex-1' : 'flex-1',
                )}
              >
                <ChannelChatPanel
                  channelId={channel._id}
                  onClose={() => setChatOpen(false)}
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </DrawerContent>
    </Drawer>
  )
}
