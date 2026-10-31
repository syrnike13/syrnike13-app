import { useIsSpeaking, useParticipants } from '@livekit/react-native'
import type { VoiceDirector, VoiceSnapshot } from '@syrnike13/platform'
import { useTranslations } from '@syrnike13/ui/i18n'
import { cn } from '@syrnike13/ui-native/lib/cn'
import { Button } from '@syrnike13/ui-native/primitives/button'
import { Text } from '@syrnike13/ui-native/primitives/text'
import type { Participant } from 'livekit-client'
import { useEffect } from 'react'
import { BackHandler, ScrollView, useWindowDimensions, View } from 'react-native'

import { ChevronDownIcon } from '../components/icons/registry'
import { CallControls } from './call-controls'
import { fitTile, useCallTracks, VideoTile } from './video-tile'

/** Horizontal padding of the stage (`px-4` on both sides). */
const TILE_INSET = 32
/** A portrait video takes at most this share of the screen height. */
const MAX_TILE_HEIGHT = 0.6

function ParticipantRow({ participant }: { participant: Participant }) {
  const speaking = useIsSpeaking(participant)
  return (
    <View className="flex-row items-center gap-2 py-1">
      <View className={cn('size-2 rounded-full', speaking ? 'bg-success' : 'bg-muted')} />
      <Text>{participant.name}</Text>
    </View>
  )
}

/** Full-screen stage of the active call; minimizing keeps the call in a floating window. */
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
  const tracks = useCallTracks()
  const participants = useParticipants()
  const window = useWindowDimensions()

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onMinimize()
      return true
    })
    return () => subscription.remove()
  }, [onMinimize])

  return (
    <View className="flex-1">
      <View className="flex-row items-center gap-3 p-4">
        <Button variant="ghost" size="icon" accessibilityLabel={t('minimize')} onPress={onMinimize}>
          <ChevronDownIcon size={24} />
        </Button>
        <View className="flex-1">
          <Text className="font-semibold">{channelName}</Text>
          <Text className="text-sm text-muted-foreground">
            {t(`connection.${snapshot.connection}`)}
            {snapshot.failure ? ` · ${snapshot.failure.message}` : ''}
          </Text>
        </View>
      </View>
      <ScrollView className="flex-1" contentContainerClassName="gap-3 px-4 pb-4">
        {tracks.map((ref) => (
          <VideoTile
            key={`${ref.participant.identity}:${ref.source}`}
            trackRef={ref}
            className="self-center"
            style={fitTile(ref, window.width - TILE_INSET, window.height * MAX_TILE_HEIGHT)}
          />
        ))}
        <View>
          {participants.map((participant) => (
            <ParticipantRow key={participant.identity} participant={participant} />
          ))}
        </View>
      </ScrollView>
      <View className="gap-2 border-t border-border bg-card p-4">
        {[snapshot.microphone, snapshot.camera, snapshot.screen].map((media, index) =>
          media.error ? (
            <Text key={index} className="text-sm text-destructive">
              {media.error.message}
            </Text>
          ) : null,
        )}
        <CallControls director={director} snapshot={snapshot} />
      </View>
    </View>
  )
}
