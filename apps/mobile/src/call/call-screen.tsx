import { useIsSpeaking, useParticipants, type TrackReference } from '@livekit/react-native'
import { useSyncStore } from '@syrnike13/client/sync/sync-store'
import type { VoiceDirector, VoiceSnapshot } from '@syrnike13/platform'
import { useTranslations } from '@syrnike13/ui/i18n'
import { cn } from '@syrnike13/ui-native/lib/cn'
import { Avatar } from '@syrnike13/ui-native/primitives/avatar'
import { Button } from '@syrnike13/ui-native/primitives/button'
import { Text } from '@syrnike13/ui-native/primitives/text'
import { Track, type Participant } from 'livekit-client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Animated, BackHandler, Pressable, useWindowDimensions, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { ChevronDownIcon, HeadphoneOffIcon, HeadphonesIcon } from '../components/icons/registry'
import { displayName } from '../lib/presence'
import { mediaUrl } from '../lib/media'
import { userIdFromIdentity } from '../voice/livekit-engine'
import { CallDock } from './call-controls'
import { fitTile, useCallTracks, VideoTile } from './video-tile'

/** Discord hides the call chrome this long after it was last shown or used. */
const CONTROLS_IDLE_MS = 3_000
/** Stage padding from the screen edges (12dp on both sides). */
const STAGE_INSET = 24

/**
 * Full-screen call stage. The top bar and the control dock hide after a few
 * idle seconds (sliding out) and come back with a tap anywhere on the stage.
 */
export function CallScreen({
  director,
  snapshot,
  channelName,
  onMinimize,
}: {
  director: VoiceDirector
  snapshot: VoiceSnapshot
  channelName: string
  onMinimize: () => void
}) {
  const t = useTranslations('mobile.voice')
  const insets = useSafeAreaInsets()
  const [visible, setVisible] = useState(true)
  const [activity, setActivity] = useState(0)
  const shown = useRef(new Animated.Value(1)).current

  // Any control press keeps the chrome up for another idle period.
  const touch = useCallback(() => setActivity((value) => value + 1), [])

  useEffect(() => {
    Animated.timing(shown, { toValue: visible ? 1 : 0, duration: 200, useNativeDriver: true }).start()
    if (!visible) return
    const timer = setTimeout(() => setVisible(false), CONTROLS_IDLE_MS)
    return () => clearTimeout(timer)
  }, [activity, shown, visible])

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onMinimize()
      return true
    })
    return () => subscription.remove()
  }, [onMinimize])

  const topStyle = {
    opacity: shown,
    transform: [{ translateY: shown.interpolate({ inputRange: [0, 1], outputRange: [-96, 0] }) }],
  }
  const dockStyle = {
    opacity: shown,
    transform: [{ translateY: shown.interpolate({ inputRange: [0, 1], outputRange: [140, 0] }) }],
  }

  return (
    <View className="flex-1 bg-background">
      <Pressable className="flex-1 justify-center" onPress={() => setVisible((value) => !value)}>
        <Stage />
      </Pressable>

      <Animated.View
        pointerEvents={visible ? 'box-none' : 'none'}
        style={[{ position: 'absolute', top: 8, left: 16, right: 16 }, topStyle]}
        className="flex-row items-center gap-3"
      >
        <Button variant="secondary" size="icon" accessibilityLabel={t('minimize')} onPress={onMinimize}>
          <ChevronDownIcon />
        </Button>
        <View className="h-8 min-w-0 shrink justify-center rounded-lg bg-secondary px-3">
          <Text className="font-semibold" numberOfLines={1}>
            {channelName}
          </Text>
        </View>
        <View className="flex-1" />
        <Button
          variant={snapshot.userDeafened ? 'destructive' : 'secondary'}
          size="icon"
          accessibilityLabel={t(snapshot.userDeafened ? 'undeafen' : 'deafen')}
          onPress={() => {
            touch()
            director.dispatch({ type: 'setUserDeafened', deafened: !snapshot.userDeafened })
          }}
        >
          {snapshot.userDeafened ? <HeadphoneOffIcon className="text-destructive" /> : <HeadphonesIcon />}
        </Button>
      </Animated.View>

      <Animated.View
        pointerEvents={visible ? 'box-none' : 'none'}
        style={[{ position: 'absolute', left: 16, right: 16, bottom: insets.bottom + 8 }, dockStyle]}
        className="gap-2"
      >
        {snapshot.connection !== 'connected' ? (
          <Text className="text-center text-sm text-muted-foreground">
            {t(`connection.${snapshot.connection}`)}
            {snapshot.failure ? ` · ${snapshot.failure.message}` : ''}
          </Text>
        ) : null}
        {[snapshot.microphone, snapshot.camera, snapshot.screen].map((media, index) =>
          media.error ? (
            <Text key={index} className="text-center text-sm text-destructive">
              {media.error.message}
            </Text>
          ) : null,
        )}
        <CallDock director={director} snapshot={snapshot} onUse={touch} />
      </Animated.View>
    </View>
  )
}

/** Video and screen tiles first, then one avatar tile per participant without video. */
function Stage() {
  const window = useWindowDimensions()
  const tracks = useCallTracks()
  const participants = useParticipants()
  const withVideo = new Set(
    tracks.filter((ref) => ref.source === Track.Source.Camera).map((ref) => ref.participant.identity),
  )
  const audioOnly = participants.filter((participant) => !withVideo.has(participant.identity))
  const count = tracks.length + audioOnly.length
  const width = window.width - STAGE_INSET
  // One tile is a full-width square; more tiles share a two-column grid.
  const tileSize = count <= 1 ? width : (width - 8) / 2

  return (
    // A plain view, not a ScrollView, so a tap anywhere reaches the stage toggle.
    <View className="flex-row flex-wrap justify-center gap-2 px-3 py-24">
      {tracks.map((ref) => (
        <VideoTile key={`${ref.participant.identity}:${ref.source}`} trackRef={ref} style={fitVideo(ref, count, width, tileSize)} />
      ))}
      {audioOnly.map((participant) => (
        <ParticipantTile key={participant.identity} participant={participant} size={tileSize} />
      ))}
    </View>
  )
}

function fitVideo(ref: TrackReference, count: number, width: number, tileSize: number) {
  return count <= 1 ? fitTile(ref, width, width * 1.4) : { width: tileSize, height: tileSize }
}

/** Avatar tile: the avatar centred on a card, the name in a pill at the bottom. */
function ParticipantTile({ participant, size }: { participant: Participant; size: number }) {
  const speaking = useIsSpeaking(participant)
  const user = useSyncStore((state) => state.users[userIdFromIdentity(participant.identity)])
  const name = displayName(user) || participant.name || ''

  return (
    <View
      style={{ width: size, height: size }}
      className={cn(
        'items-center justify-center rounded-xl border-2 bg-card',
        speaking ? 'border-success' : 'border-transparent',
      )}
    >
      <Avatar size={size > 200 ? '2xl' : 'xl'} src={mediaUrl(user?.avatar)} name={name || '?'} />
      <View className="absolute bottom-3 rounded-lg bg-background/80 px-3 py-1">
        <Text className="text-sm font-medium" numberOfLines={1}>
          {name}
        </Text>
      </View>
    </View>
  )
}
