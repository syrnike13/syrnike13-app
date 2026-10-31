import { RoomContext } from '../voice/livekit'
import { useSyncStore } from '@syrnike13/client/sync/sync-store'
import { router, usePathname } from 'expo-router'
import type { ReactNode } from 'react'
import { View } from 'react-native'

import { useVoice } from '../voice/voice-provider'
import { CallMiniWindow } from './call-mini-window'
import { PictureInPictureView, usePictureInPicture } from './picture-in-picture'
import { pickFocusTrack, trackAspect, useCallTracks } from './video-tile'

export function useActiveChannelName() {
  const { snapshot } = useVoice()
  return useSyncStore((state) => {
    const id = snapshot.intentChannelId
    const channel = id ? state.channels[id] : undefined
    return channel && 'name' in channel ? channel.name : ''
  })
}

/**
 * Where the active call lives outside its own screen: a floating window over
 * the app, or the whole UI while Android shows the app in picture-in-picture.
 * The tree around `children` never changes shape, so the navigator inside is
 * not remounted when a call starts or ends.
 */
export function CallLayer({ children }: { children: ReactNode }) {
  const { snapshot, room } = useVoice()
  return (
    <RoomContext.Provider value={room ?? undefined}>
      <View className="flex-1">
        {children}
        {room && snapshot.intentChannelId ? <CallOverlays /> : null}
      </View>
    </RoomContext.Provider>
  )
}

function CallOverlays() {
  const pathname = usePathname()
  const channelName = useActiveChannelName()
  const focus = pickFocusTrack(useCallTracks())
  const inPictureInPicture = usePictureInPicture(true, trackAspect(focus))

  if (inPictureInPicture) {
    return (
      <View className="absolute inset-0 bg-background">
        <PictureInPictureView channelName={channelName} />
      </View>
    )
  }
  return pathname === '/call' ? null : <CallMiniWindow onOpen={() => router.push('/call')} />
}
