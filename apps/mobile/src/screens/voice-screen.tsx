import { RoomContext } from '@livekit/react-native'
import type { VoiceDirector, VoiceSnapshot } from '@syrnike13/platform'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Button } from '@syrnike13/ui-native/primitives/button'
import { Text } from '@syrnike13/ui-native/primitives/text'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { PermissionsAndroid, ScrollView, View } from 'react-native'

import { CallService } from '../../modules/call-service'
import { CallMiniWindow } from '../call/call-mini-window'
import { CallScreen } from '../call/call-screen'
import { PictureInPictureView, usePictureInPicture } from '../call/picture-in-picture'
import { pickFocusTrack, trackAspect, useCallTracks } from '../call/video-tile'
import { useVoice, type VoiceChannelGroup } from '../voice/use-voice'

async function requestCallPermissions() {
  const results = await PermissionsAndroid.requestMultiple([
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
  ])
  return results[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] === 'granted'
}

export function VoiceScreen({ token, onLogout }: { token: string; onLogout: () => void }) {
  const t = useTranslations('mobile.voice')
  const { director, snapshot, room, groups } = useVoice(token)
  const [callOpen, setCallOpen] = useState(false)
  const channelNames = useMemo(
    () => new Map(groups.flatMap((g) => g.channels.map((c) => [c._id, c.name ?? c._id]))),
    [groups],
  )
  const activeChannelId = snapshot?.intentChannelId ?? null
  const channelName = activeChannelId ? (channelNames.get(activeChannelId) ?? '') : ''

  // The microphone foreground service keeps the call alive in the background.
  useEffect(() => {
    if (!activeChannelId) return
    CallService.start(t('notificationTitle'), channelName)
    return () => CallService.stop()
  }, [activeChannelId, channelName, t])

  async function join(channelId: string) {
    if (!(await requestCallPermissions())) return
    director?.dispatch({ type: 'join', channelId })
    setCallOpen(true)
  }

  const channelList = (
    <ChannelList
      groups={groups}
      activeChannelId={activeChannelId}
      onJoin={join}
      onLogout={onLogout}
    />
  )
  if (!director || !snapshot || !room || !activeChannelId) return channelList

  return (
    <RoomContext.Provider value={room}>
      <ActiveCall
        director={director}
        snapshot={snapshot}
        channelName={channelName}
        open={callOpen}
        onOpenChange={setCallOpen}
      >
        {channelList}
      </ActiveCall>
    </RoomContext.Provider>
  )
}

/** Where the active call lives: full stage, floating over the app, or the system PiP window. */
function ActiveCall({
  director,
  snapshot,
  channelName,
  open,
  onOpenChange,
  children,
}: {
  director: VoiceDirector
  snapshot: VoiceSnapshot
  channelName: string
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
}) {
  const focus = pickFocusTrack(useCallTracks())
  const inPictureInPicture = usePictureInPicture(true, trackAspect(focus))

  if (inPictureInPicture) return <PictureInPictureView channelName={channelName} />
  if (open) {
    return (
      <CallScreen
        director={director}
        snapshot={snapshot}
        channelName={channelName}
        onMinimize={() => onOpenChange(false)}
      />
    )
  }
  return (
    <View className="flex-1">
      {children}
      <CallMiniWindow channelName={channelName} onOpen={() => onOpenChange(true)} />
    </View>
  )
}

function ChannelList({
  groups,
  activeChannelId,
  onJoin,
  onLogout,
}: {
  groups: VoiceChannelGroup[]
  activeChannelId: string | null
  onJoin: (channelId: string) => void
  onLogout: () => void
}) {
  const t = useTranslations('mobile.voice')
  return (
    <ScrollView className="flex-1" contentContainerClassName="gap-4 p-4">
      <View className="flex-row items-center justify-between">
        <Text className="text-2xl font-semibold">{t('title')}</Text>
        <Button variant="ghost" size="sm" onPress={onLogout}>
          <Text>{t('logout')}</Text>
        </Button>
      </View>
      {groups.length === 0 ? <Text className="text-muted-foreground">{t('loading')}</Text> : null}
      {groups.map(({ server, channels }) => (
        <View key={server._id} className="gap-1">
          <Text className="text-sm font-semibold text-muted-foreground">{server.name}</Text>
          {channels.map((channel) => (
            <Button
              key={channel._id}
              variant={channel._id === activeChannelId ? 'secondary' : 'ghost'}
              className="justify-start"
              onPress={() => onJoin(channel._id)}
            >
              <Text>{channel.name}</Text>
            </Button>
          ))}
        </View>
      ))}
    </ScrollView>
  )
}
