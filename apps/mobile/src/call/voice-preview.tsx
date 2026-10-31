import { useSyncStore } from '@syrnike13/client/sync/sync-store'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Avatar } from '@syrnike13/ui-native/primitives/avatar'
import { Button } from '@syrnike13/ui-native/primitives/button'
import { Text } from '@syrnike13/ui-native/primitives/text'
import { router } from 'expo-router'
import { createContext, useContext, useState, type ReactNode } from 'react'
import { Modal, Pressable, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { ChevronDownIcon, MicIcon, MicOffIcon } from '../components/icons/registry'
import { displayName } from '../lib/presence'
import { mediaUrl } from '../lib/media'
import { useVoiceChannelUsers } from '../voice/voice-channel-users'
import { useVoice } from '../voice/voice-provider'

const VoicePreviewContext = createContext<(channelId: string) => void>(() => {})

/** Opens the voice channel sheet; in your own active channel it opens the call. */
export function useOpenVoiceChannel() {
  return useContext(VoicePreviewContext)
}

export function VoicePreviewProvider({ children }: { children: ReactNode }) {
  const { snapshot } = useVoice()
  const [channelId, setChannelId] = useState<string | null>(null)

  function open(id: string) {
    if (snapshot.intentChannelId === id) router.push('/call')
    else setChannelId(id)
  }

  return (
    <VoicePreviewContext.Provider value={open}>
      {children}
      <Modal
        visible={channelId !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setChannelId(null)}
      >
        {channelId ? <VoicePreviewSheet channelId={channelId} onClose={() => setChannelId(null)} /> : null}
      </Modal>
    </VoicePreviewContext.Provider>
  )
}

/**
 * Discord's voice channel sheet: who is there, the microphone to set before
 * joining, and the big join button. Joining opens the call stage.
 */
function VoicePreviewSheet({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const t = useTranslations('mobile.voice')
  const voice = useVoice()
  const insets = useSafeAreaInsets()
  const name = useSyncStore((state) => {
    const channel = state.channels[channelId]
    return channel && 'name' in channel ? channel.name : ''
  })
  const users = useVoiceChannelUsers(channelId)
  const muted = voice.snapshot.userMuted

  async function join() {
    if (await voice.join(channelId)) {
      onClose()
      router.push('/call')
    }
  }

  return (
    <View className="flex-1 justify-end">
      <Pressable accessibilityLabel={t('collapse')} className="flex-1" onPress={onClose} />
      <View className="max-h-3/4 rounded-t-3xl bg-background pt-4" style={{ paddingBottom: insets.bottom + 16 }}>
        <View className="flex-row items-center gap-3 px-4">
          <Button variant="secondary" size="icon" accessibilityLabel={t('collapse')} onPress={onClose}>
            <ChevronDownIcon />
          </Button>
          <View className="h-8 justify-center rounded-lg bg-secondary px-3">
            <Text className="font-semibold" numberOfLines={1}>
              {name}
            </Text>
          </View>
        </View>

        <ScrollView className="grow-0" contentContainerClassName="gap-3 px-4 py-6">
          {users.length === 0 ? (
            <Text className="text-center text-muted-foreground">{t('empty')}</Text>
          ) : (
            users.map((user) => (
              <View key={user._id} className="flex-row items-center gap-3">
                <Avatar size="lg" src={mediaUrl(user.avatar)} name={displayName(user)} />
                <Text className="font-medium" numberOfLines={1}>
                  {displayName(user)}
                </Text>
              </View>
            ))
          )}
        </ScrollView>

        <View className="mx-4 flex-row items-center gap-3 rounded-3xl bg-card p-4">
          <Button
            size="icon-xl"
            variant={muted ? 'destructive' : 'secondary'}
            accessibilityLabel={t(muted ? 'unmute' : 'mute')}
            onPress={() => voice.director.dispatch({ type: 'setUserMuted', muted: !muted })}
          >
            {muted ? <MicOffIcon size={24} className="text-destructive" /> : <MicIcon size={24} />}
          </Button>
          <Button variant="success" size="lg" className="h-12 flex-1" onPress={join}>
            <Text className="text-center font-semibold">{t('joinVoice')}</Text>
          </Button>
        </View>
      </View>
    </View>
  )
}
