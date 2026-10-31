import type { VoiceDirector, VoiceSnapshot } from '@syrnike13/platform'
import type { Room } from 'livekit-client'
import { useEffect, useState } from 'react'

import { Gateway } from '../gateway/gateway'
import { createVoiceDirector } from './voice'

type ReadyServer = { _id: string; name: string; channels: string[] }
export type ReadyChannel = { _id: string; name?: string; channel_type: string; voice?: unknown }
export type VoiceChannelGroup = { server: ReadyServer; channels: ReadyChannel[] }

/** One gateway session with its voice director, the live room and the voice channels from Ready. */
export function useVoice(token: string) {
  const [director, setDirector] = useState<VoiceDirector | null>(null)
  const [snapshot, setSnapshot] = useState<VoiceSnapshot | null>(null)
  const [room, setRoom] = useState<Room | null>(null)
  const [groups, setGroups] = useState<VoiceChannelGroup[]>([])

  useEffect(() => {
    const gateway = new Gateway(token)
    const { director, engine } = createVoiceDirector(gateway)
    setDirector(director)
    setSnapshot(director.snapshot())
    const unsubscribeVoice = director.subscribe(setSnapshot)
    const unsubscribeRoom = engine.subscribeRoom(setRoom)
    const unsubscribeEvents = gateway.subscribeEvents((event) => {
      if (event.type !== 'Ready') return
      const servers = (event.servers ?? []) as ReadyServer[]
      const channels = new Map(
        ((event.channels ?? []) as ReadyChannel[]).map((channel) => [channel._id, channel]),
      )
      setGroups(
        servers
          .map((server) => ({
            server,
            channels: server.channels
              .map((id) => channels.get(id))
              .filter((channel): channel is ReadyChannel => !!channel?.voice),
          }))
          .filter((group) => group.channels.length > 0),
      )
    })
    return () => {
      unsubscribeVoice()
      unsubscribeRoom()
      unsubscribeEvents()
      director.dispose()
      gateway.close()
    }
  }, [token])

  return { director, snapshot, room, groups }
}
