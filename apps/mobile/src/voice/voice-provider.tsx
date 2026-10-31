import { useSyncStore } from '@syrnike13/client/sync/sync-store'
import type { VoiceDirector, VoiceSnapshot } from '@syrnike13/platform'
import { useTranslations } from '@syrnike13/ui/i18n'
import type { Room } from 'livekit-client'
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { CallService } from '../../modules/call-service'
import { requestCallPermissions } from '../lib/permissions'
import { createVoiceDirector } from './voice'

type Voice = {
  director: VoiceDirector
  snapshot: VoiceSnapshot
  room: Room | null
  /** Asks for the microphone, then joins; resolves false when it was refused. */
  join(channelId: string): Promise<boolean>
}

const VoiceContext = createContext<Voice | null>(null)

/** One voice session per signed-in user; the call outlives screen changes. */
export function VoiceProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const t = useTranslations('mobile.voice')
  const [voice, setVoice] = useState<Omit<Voice, 'snapshot' | 'room' | 'join'> | null>(null)
  const [snapshot, setSnapshot] = useState<VoiceSnapshot | null>(null)
  const [room, setRoom] = useState<Room | null>(null)
  const channelName = useSyncStore((state) => {
    const id = snapshot?.intentChannelId
    const channel = id ? state.channels[id] : undefined
    return channel && 'name' in channel ? channel.name : ''
  })

  useEffect(() => {
    const { director, engine } = createVoiceDirector(userId)
    setVoice({ director })
    setSnapshot(director.snapshot())
    const unsubscribeVoice = director.subscribe(setSnapshot)
    const unsubscribeRoom = engine.subscribeRoom(setRoom)
    return () => {
      unsubscribeVoice()
      unsubscribeRoom()
      director.dispose()
    }
  }, [userId])

  // The microphone foreground service keeps the call alive in the background.
  const activeChannelId = snapshot?.intentChannelId ?? null
  useEffect(() => {
    if (!activeChannelId) return
    CallService.start(t('notificationTitle'), channelName)
    return () => CallService.stop()
  }, [activeChannelId, channelName, t])

  if (!voice || !snapshot) return null
  const value: Voice = {
    ...voice,
    snapshot,
    room,
    async join(channelId) {
      if (!(await requestCallPermissions())) return false
      voice.director.dispatch({ type: 'join', channelId })
      return true
    },
  }
  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>
}

export function useVoice() {
  const voice = useContext(VoiceContext)
  if (!voice) throw new Error('useVoice must be used inside VoiceProvider')
  return voice
}
