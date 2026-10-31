import { useParticipants } from '../voice/livekit'
import { Text } from '@syrnike13/ui-native/primitives/text'
import { useEffect, useState } from 'react'
import { View } from 'react-native'

import { CallService } from '../../modules/call-service'
import { pickFocusTrack, useCallTracks, VideoTile } from './video-tile'

/**
 * Arms Android's picture-in-picture while `enabled`: leaving the app shrinks
 * it into a system window. Returns whether the app is in that window now.
 */
export function usePictureInPicture(enabled: boolean, aspect: [number, number]) {
  const [active, setActive] = useState(() => CallService.isInPictureInPicture())
  const [width, height] = aspect

  useEffect(() => {
    const subscription = CallService.addListener('onPictureInPictureModeChanged', (event) =>
      setActive(event.active),
    )
    return () => subscription.remove()
  }, [])

  useEffect(() => {
    CallService.setPictureInPicture(enabled, width, height)
    return () => CallService.setPictureInPicture(false, width, height)
  }, [enabled, width, height])

  return active
}

/** The whole UI inside the system PiP window: the focused video or who is talking. */
export function PictureInPictureView({ channelName }: { channelName: string }) {
  const tracks = useCallTracks()
  const participants = useParticipants()
  const focus = pickFocusTrack(tracks)
  const speaking = participants.filter((participant) => participant.isSpeaking)

  if (focus) return <VideoTile trackRef={focus} className="flex-1 rounded-none border-0" />
  return (
    <View className="flex-1 justify-center gap-1 bg-card p-3">
      <Text className="font-semibold" numberOfLines={1}>
        {channelName}
      </Text>
      {speaking.map((participant) => (
        <Text key={participant.identity} className="text-sm text-success" numberOfLines={1}>
          {participant.name}
        </Text>
      ))}
    </View>
  )
}
