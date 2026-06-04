import {
  Maximize2Icon,
  MessageSquareIcon,
  Minimize2Icon,
  Volume2Icon,
} from 'lucide-react'
import type { Channel } from '@syrnike13/api-types'

import { Button } from '#/components/ui/button'
import {
  VoiceStageInviteTile,
  VoiceStageTile,
} from '#/components/voice/voice-stage-tile'
import { VoiceStageControls } from '#/components/voice/voice-stage-controls'
import { useAuth } from '#/features/auth/auth-context'
import {
  getChannelVoiceParticipants,
  useMergedChannelVoiceParticipants,
} from '#/features/sync/voice-selectors'
import { useSyncStore } from '#/features/sync/sync-store'
import { useChannelVoiceState } from '#/features/voice/use-channel-voice-state'
import { useVoice } from '#/features/voice/voice-provider'
import {
  shouldShowVoiceInviteSlot,
  voiceStageGridClass,
} from '#/components/voice/voice-stage-layout'
import { cn } from '#/lib/utils'

type VoiceStageViewProps = {
  channel: Extract<Channel, { channel_type: 'TextChannel' | 'VoiceChannel' }>
  title: string
  chatOpen: boolean
  onToggleChat: () => void
}

function participantDisplayName(
  userId: string,
  users: Record<string, import('@syrnike13/api-types').User>,
  currentUserId?: string,
) {
  if (userId === currentUserId) return 'Вы'
  const user = users[userId]
  return user?.display_name ?? user?.username ?? 'Участник'
}

export function VoiceStageView({
  channel,
  title,
  chatOpen,
  onToggleChat,
}: VoiceStageViewProps) {
  const auth = useAuth()
  const voice = useVoice()
  const channelId = channel._id
  useChannelVoiceState(channelId)
  const users = useSyncStore((s) => s.users)
  const storeParticipants = useSyncStore((s) =>
    getChannelVoiceParticipants(s, channelId, auth.user?._id),
  )
  const inThisVoiceCall =
    voice.channelId === channelId && voice.status === 'connected'
  const connecting =
    voice.channelId === channelId && voice.status === 'connecting'

  const participants = useMergedChannelVoiceParticipants(
    channelId,
    storeParticipants,
    voice.liveChannelParticipants,
    inThisVoiceCall,
    inThisVoiceCall ? auth.user?._id : undefined,
    inThisVoiceCall ? voice.micEnabled : undefined,
    inThisVoiceCall ? voice.deafened : undefined,
  )

  const showInviteSlot = shouldShowVoiceInviteSlot(participants.length)
  const focusUserId = voice.focusUserId
  const showInviteInGrid = showInviteSlot && !focusUserId
  const slotCount = participants.length + (showInviteInGrid ? 1 : 0)
  const gridCompact = slotCount > 6
  const focusParticipant = focusUserId
    ? participants.find((participant) => participant.id === focusUserId)
    : undefined
  const filmstrip = focusUserId
    ? participants.filter((participant) => participant.id !== focusUserId)
    : participants

  return (
    <div
      className={cn(
        'flex min-h-0 min-w-0 flex-1 flex-col bg-[#1e1f22] text-foreground',
        voice.stageFullscreen && 'fixed inset-0 z-50',
      )}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-white/10 px-4">
        <Volume2Icon className="size-5 shrink-0 text-muted-foreground" />
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h1>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-9 shrink-0"
          title={voice.stageFullscreen ? 'Выйти из полноэкранного' : 'На весь экран'}
          onClick={voice.toggleStageFullscreen}
        >
          {voice.stageFullscreen ? (
            <Minimize2Icon className="size-5" />
          ) : (
            <Maximize2Icon className="size-5" />
          )}
        </Button>
        <Button
          type="button"
          variant={chatOpen ? 'secondary' : 'ghost'}
          size="icon"
          className="size-9 shrink-0"
          title={chatOpen ? 'Скрыть чат' : 'Открыть чат'}
          aria-pressed={chatOpen}
          onClick={onToggleChat}
        >
          <MessageSquareIcon className="size-5" />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
          {participants.length === 0 ? (
            <div className="flex h-full min-h-[min(50vh,20rem)] flex-col items-center justify-center gap-3 text-center">
              <p className="text-lg font-semibold">Никого нет в канале</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                Подключитесь к голосу или пригласите участников на сервер.
              </p>
            </div>
          ) : focusParticipant ? (
            <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-3">
              <VoiceStageTile
                participant={focusParticipant}
                user={users[focusParticipant.id]}
                displayName={participantDisplayName(
                  focusParticipant.id,
                  users,
                  auth.user?._id,
                )}
                speaking={
                  inThisVoiceCall &&
                  voice.speakingUserIds.has(focusParticipant.id)
                }
                focused
                onSelect={() => voice.setFocusUserId(null)}
              />
              {filmstrip.length > 0 ? (
                <div
                  className={cn(
                    'grid auto-rows-fr items-start gap-2 sm:gap-3',
                    voiceStageGridClass(filmstrip.length),
                  )}
                >
                  {filmstrip.map((participant) => (
                    <VoiceStageTile
                      key={participant.id}
                      participant={participant}
                      user={users[participant.id]}
                      displayName={participantDisplayName(
                        participant.id,
                        users,
                        auth.user?._id,
                      )}
                      speaking={
                        inThisVoiceCall &&
                        voice.speakingUserIds.has(participant.id)
                      }
                      compact
                      onSelect={() => voice.setFocusUserId(participant.id)}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <div
              className={cn(
                'mx-auto grid w-full auto-rows-fr items-start gap-2 sm:gap-3',
                voiceStageGridClass(slotCount),
              )}
            >
              {participants.map((participant) => {
                const user = users[participant.id]
                return (
                  <VoiceStageTile
                    key={participant.id}
                    participant={participant}
                    user={user}
                    displayName={participantDisplayName(
                      participant.id,
                      users,
                      auth.user?._id,
                    )}
                    speaking={
                      inThisVoiceCall &&
                      voice.speakingUserIds.has(participant.id)
                    }
                    compact={gridCompact}
                    onSelect={() => voice.setFocusUserId(participant.id)}
                  />
                )
              })}
              {showInviteInGrid ? (
                <VoiceStageInviteTile
                  channelId={channelId}
                  compact={gridCompact}
                />
              ) : null}
            </div>
          )}
        </div>

        <VoiceStageControls
          channelId={channelId}
          inCall={inThisVoiceCall}
          connecting={connecting}
        />
      </div>

    </div>
  )
}
