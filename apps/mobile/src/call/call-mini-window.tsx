import { useParticipants } from '@livekit/react-native'
import { Text } from '@syrnike13/ui-native/primitives/text'
import { useEffect, useRef } from 'react'
import { Animated, PanResponder, Pressable, useWindowDimensions, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { pickFocusTrack, trackAspect, useCallTracks, VideoTile } from './video-tile'

const WIDTH = 132
const MARGIN = 12
/** Movement that turns a touch into a drag instead of a tap. */
const DRAG_SLOP = 6

/**
 * Discord-style floating window of the active call while the user browses
 * the app. Drag it around; on release it snaps to the nearest side.
 */
export function CallMiniWindow({ channelName, onOpen }: { channelName: string; onOpen: () => void }) {
  const tracks = useCallTracks()
  const participants = useParticipants()
  const focus = pickFocusTrack(tracks)
  const [aspectWidth, aspectHeight] = trackAspect(focus)
  const height = Math.round(WIDTH * Math.min(aspectHeight / aspectWidth, 16 / 9))

  const window = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const bounds = {
    left: MARGIN,
    right: window.width - WIDTH - MARGIN,
    top: insets.top + MARGIN,
    bottom: window.height - height - insets.bottom - MARGIN,
  }
  const boundsRef = useRef(bounds)
  boundsRef.current = bounds

  const position = useRef(new Animated.ValueXY({ x: bounds.right, y: bounds.bottom - 96 })).current
  // Includes the in-flight drag offset, so it is the window's on-screen spot.
  const current = useRef({ x: bounds.right, y: bounds.bottom - 96 })
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
      <Pressable className="flex-1 overflow-hidden rounded-xl bg-card shadow-lg" onPress={onOpen}>
        {focus ? (
          <VideoTile trackRef={focus} className="flex-1" zOrder={1} showLabel={false} />
        ) : (
          <View className="flex-1 justify-center gap-1 p-2">
            <Text className="text-sm font-semibold" numberOfLines={1}>
              {channelName}
            </Text>
            <Text className="text-xs text-muted-foreground">{participants.length}</Text>
          </View>
        )}
      </Pressable>
    </Animated.View>
  )
}
