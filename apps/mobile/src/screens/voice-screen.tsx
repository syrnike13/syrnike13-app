import type { VoiceDirector, VoiceSnapshot } from '@syrnike13/platform'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Button } from '@syrnike13/ui-native/primitives/button'
import { Text } from '@syrnike13/ui-native/primitives/text'
import { useEffect, useMemo, useState } from 'react'
import { PermissionsAndroid, ScrollView, View } from 'react-native'

import { CallService } from '../../modules/call-service'
import { Gateway } from '../gateway/gateway'
import { createVoiceDirector } from '../voice/voice'

type ReadyServer = { _id: string; name: string; channels: string[] }
type ReadyChannel = { _id: string; name?: string; channel_type: string; voice?: unknown }
type VoiceChannelGroup = { server: ReadyServer; channels: ReadyChannel[] }

function useVoice(token: string) {
  const [director, setDirector] = useState<VoiceDirector | null>(null)
  const [snapshot, setSnapshot] = useState<VoiceSnapshot | null>(null)
  const [groups, setGroups] = useState<VoiceChannelGroup[]>([])

  useEffect(() => {
    const gateway = new Gateway(token)
    const director = createVoiceDirector(gateway)
    setDirector(director)
    setSnapshot(director.snapshot())
    const unsubscribeVoice = director.subscribe(setSnapshot)
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
      unsubscribeEvents()
      director.dispose()
      gateway.close()
    }
  }, [token])

  return { director, snapshot, groups }
}

async function requestCallPermissions() {
  const results = await PermissionsAndroid.requestMultiple([
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
  ])
  return results[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] === 'granted'
}

export function VoiceScreen({ token, onLogout }: { token: string; onLogout: () => void }) {
  const t = useTranslations('mobile.voice')
  const { director, snapshot, groups } = useVoice(token)
  const channelNames = useMemo(
    () => new Map(groups.flatMap((g) => g.channels.map((c) => [c._id, c.name ?? c._id]))),
    [groups],
  )
  const activeChannelId = snapshot?.intentChannelId ?? null

  // The microphone foreground service keeps the call alive in the background.
  useEffect(() => {
    if (!activeChannelId) return
    CallService.start(t('notificationTitle'), channelNames.get(activeChannelId) ?? '')
    return () => CallService.stop()
  }, [activeChannelId, channelNames, t])

  async function join(channelId: string) {
    if (await requestCallPermissions()) director?.dispatch({ type: 'join', channelId })
  }

  return (
    <View className="flex-1">
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
                onPress={() => join(channel._id)}
              >
                <Text>{channel.name}</Text>
              </Button>
            ))}
          </View>
        ))}
      </ScrollView>
      {director && snapshot && activeChannelId ? (
        <CallBar
          director={director}
          snapshot={snapshot}
          channelName={channelNames.get(activeChannelId) ?? ''}
        />
      ) : null}
    </View>
  )
}

function CallBar({
  director,
  snapshot,
  channelName,
}: {
  director: VoiceDirector
  snapshot: VoiceSnapshot
  channelName: string
}) {
  const t = useTranslations('mobile.voice')
  const screenOn = snapshot.screen.state === 'running' || snapshot.screen.state === 'starting'

  return (
    <View className="gap-3 border-t border-border bg-card p-4">
      <View>
        <Text className="font-semibold">{channelName}</Text>
        <Text className="text-sm text-muted-foreground">
          {t(`connection.${snapshot.connection}`)}
          {snapshot.failure ? ` · ${snapshot.failure.message}` : ''}
        </Text>
        {snapshot.microphone.error ? (
          <Text className="text-sm text-destructive">{snapshot.microphone.error.message}</Text>
        ) : null}
      </View>
      <View className="flex-row flex-wrap gap-2">
        <Button
          variant={snapshot.userMuted ? 'destructive' : 'secondary'}
          onPress={() => director.dispatch({ type: 'setUserMuted', muted: !snapshot.userMuted })}
        >
          <Text>{t(snapshot.userMuted ? 'unmute' : 'mute')}</Text>
        </Button>
        <Button
          variant={snapshot.userDeafened ? 'destructive' : 'secondary'}
          onPress={() =>
            director.dispatch({ type: 'setUserDeafened', deafened: !snapshot.userDeafened })
          }
        >
          <Text>{t(snapshot.userDeafened ? 'undeafen' : 'deafen')}</Text>
        </Button>
        <Button
          variant="secondary"
          onPress={() => director.dispatch({ type: 'setScreen', enabled: !screenOn })}
        >
          <Text>{t(screenOn ? 'stopScreen' : 'shareScreen')}</Text>
        </Button>
        <Button variant="destructive" onPress={() => director.dispatch({ type: 'leave' })}>
          <Text>{t('leave')}</Text>
        </Button>
      </View>
    </View>
  )
}
