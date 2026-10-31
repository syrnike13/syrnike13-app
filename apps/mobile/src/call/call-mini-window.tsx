import { useParticipants, useSpeakingParticipants } from '../voice/livekit'
import { useSyncStore } from '@syrnike13/client/sync/sync-store'
import { Avatar } from '@syrnike13/ui-native/primitives/avatar'
import { useEffect, useRef } from 'react'
import { Animated, PanResponder, Pressable, useWindowDimensions, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { displayName } from '../lib/presence'
import { mediaUrl } from '../lib/media'
import { userIdFromIdentity } from '../voice/livekit-engine'
import { pickFocusTrack, trackAspect, useCallTracks, VideoTile } from './video-tile'

/** Discord's minimised call: a ~120dp square (taller only for portrait video). */
const WIDTH = 120
const MARGIN = 12
/** Starts below the screen headers, in the top-right corner like Discord. */
const TOP_OFFSET = 64
/** Movement that turns a touch into a drag instead of a tap. */
const DRAG_SLOP = 6

/**
 * Floating window of the active call while the user browses the app. Drag it
 * around; on release it snaps to the nearest side. A tap opens the stage.
 */
export function CallMiniWindow({ onOpen }: { onOpen: () => void }) {
  const tracks = useCallTracks()
  const focus = pickFocusTrack(tracks)
  const [aspectWidth, aspectHeight] = trackAspect(focus)
  const height = focus ? Math.round(WIDTH * Math.min(aspectHeight / aspectWidth, 16 / 9)) : WIDTH

  // The layer already sits below the status bar, so only the bottom inset counts.
  const window = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const bounds = {
    left: MARGIN,
    right: window.width - WIDTH - MARGIN,
    top: MARGIN,
    bottom: window.height - insets.top - height - insets.bottom - MARGIN,
  }
  const boundsRef = useRef(bounds)
  boundsRef.current = bounds

  const start = { x: bounds.right, y: TOP_OFFSET }
  const position = useRef(new Animated.ValueXY(start)).current
  // Includes the in-flight drag offset, so it is the window's on-screen spot.
  const current = useRef(start)
  useEffect(() => {
    const id = position.addListener((value) => (current.current = value))
    return () => position.removeListener(id)
  }, [position])
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gesture) =>
        Math.abs(gesture.dx) > DRAG_SLOP || Math.abs(gesture.dy) > DRAG_SLOP,
      onPanResponderGrant: () => position.extractOffset(),
      onPanResponderMove: Animated.event([null, { dx: position.x, dy: position.y }], {
        useNativeDriver: false,
      }),
      onPanResponderRelease: () => {
        position.flattenOffset()
        const { left, right, top, bottom } = boundsRef.current
        const { x, y } = current.current
        Animated.spring(position, {
          toValue: {
            x: x + WIDTH / 2 < (left + right + WIDTH) / 2 ? left : right,
            y: Math.min(Math.max(y, top), bottom),
          },
          useNativeDriver: false,
        }).start()
      },
    }),
  ).current

  return (
    <Animated.View
      {...pan.panHandlers}
      style={{ position: 'absolute', width: WIDTH, height, transform: position.getTranslateTransform() }}
    >
      <Pressable className="flex-1 overflow-hidden rounded-2xl border border-border bg-card shadow-lg" onPress={onOpen}>
        {focus ? (
          <VideoTile trackRef={focus} className="flex-1 rounded-none border-0" zOrder={1} showLabel={false} />
        ) : (
          <SpeakerAvatar />
        )}
      </Pressable>
    </Animated.View>
  )
}

/** Without video: the avatar of whoever speaks, else of the first participant. */
function SpeakerAvatar() {
  const speaking = useSpeakingParticipants()
  const participants = useParticipants()
  const participant = speaking[0] ?? participants[0]
  const user = useSyncStore((state) =>
    participant ? state.users[userIdFromIdentity(participant.identity)] : undefined,
  )
  const name = displayName(user) || participant?.name || '?'
  return (
    <View className="flex-1 items-center justify-center">
      <Avatar size="xl" className="scale-125" src={mediaUrl(user?.avatar)} name={name} />
    </View>
  )
}
