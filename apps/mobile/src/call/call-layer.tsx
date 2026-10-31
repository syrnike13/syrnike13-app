import { RoomContext } from '@livekit/react-native'
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
 */
export function CallLayer({ children }: { children: ReactNode }) {
  const { snapshot, room } = useVoice()
  if (!room || !snapshot.intentChannelId) return children
  return (
    <RoomContext.Provider value={room}>
      <ActiveCallLayer>{children}</ActiveCallLayer>
    </RoomContext.Provider>
  )
}

function ActiveCallLayer({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const channelName = useActiveChannelName()
  const focus = pickFocusTrack(useCallTracks())
  const inPictureInPicture = usePictureInPicture(true, trackAspect(focus))

  return (
    <View className="flex-1">
      {children}
      {pathname !== '/call' && !inPictureInPicture ? (
        <CallMiniWindow channelName={channelName} onOpen={() => router.push('/call')} />
      ) : null}
      {inPictureInPicture ? (
        <View className="absolute inset-0 bg-background">
          <PictureInPictureView channelName={channelName} />
        </View>
      ) : null}
    </View>
  )
}
