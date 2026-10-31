import type { DataEditUser } from '@syrnike13/api-types'
import { uploadMediaFile } from '@syrnike13/client/api/media-api'
import { updateCurrentUserEffect } from '@syrnike13/client/api/users-api'
import { syncStore, useSyncStore } from '@syrnike13/client/sync/sync-store'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Avatar } from '@syrnike13/ui-native/primitives/avatar'
import { Button } from '@syrnike13/ui-native/primitives/button'
import { Input } from '@syrnike13/ui-native/primitives/input'
import { Text } from '@syrnike13/ui-native/primitives/text'
import { Effect } from 'effect'
import * as DocumentPicker from 'expo-document-picker'
import { router } from 'expo-router'
import { useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'

import { useSession } from '../auth/session-context'
import { ArrowLeftIcon } from '../components/icons/registry'
import { mediaUrl } from '../lib/media'
import { displayName } from '../lib/presence'

/**
 * Edit profile: the avatar changes as soon as a picture is picked; the
 * display name is saved with the button (empty falls back to the username).
 */
export function EditProfileScreen() {
  const t = useTranslations('mobile.editProfile')
  const tMedia = useTranslations('mobile.media')
  const { session } = useSession()
  const user = useSyncStore((state) => state.users[session.userId])
  const [name, setName] = useState(user?.display_name ?? '')
  const [busy, setBusy] = useState<'avatar' | 'name' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function update(data: DataEditUser) {
    const updated = await Effect.runPromise(updateCurrentUserEffect(session.token, data))
    syncStore.upsertUser(updated)
  }

  async function run(kind: 'avatar' | 'name', action: () => Promise<void>) {
    setBusy(kind)
    setError(null)
    setSaved(false)
    try {
      await action()
      if (kind === 'name') setSaved(true)
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t('failed'))
    } finally {
      setBusy(null)
    }
  }

  async function pickAvatar() {
    const result = await DocumentPicker.getDocumentAsync({ type: 'image/*', copyToCacheDirectory: true })
    if (result.canceled) return
    const asset = result.assets[0]
    if (!asset) return
    const file = asset.file ?? { uri: asset.uri, name: asset.name, type: asset.mimeType ?? 'image/png' }
    await run('avatar', async () => {
      const avatar = await uploadMediaFile(session.token, 'avatars', file, tMedia)
      await update({ avatar })
    })
  }

  const trimmed = name.trim()
  const nameChanged = trimmed !== (user?.display_name ?? '')

  return (
    <View className="flex-1 bg-background">
      <View className="h-14 flex-row items-center gap-2 border-b border-border pr-4 pl-2">
        <Button variant="ghost" size="icon-lg" accessibilityLabel={t('back')} onPress={() => router.back()}>
          <ArrowLeftIcon size={24} />
        </Button>
        <Text className="text-2xl font-bold">{t('title')}</Text>
      </View>
      <ScrollView contentContainerClassName="gap-6 p-4 pb-12">
        <View className="items-start gap-3">
          <Pressable
            role="button"
            accessibilityLabel={t('changeAvatar')}
            disabled={busy !== null}
            onPress={() => void pickAvatar()}
          >
            <Avatar size="2xl" src={mediaUrl(user?.avatar)} name={displayName(user) || '?'} />
          </Pressable>
          <View className="flex-row gap-2">
            <Button variant="secondary" size="sm" disabled={busy !== null} onPress={() => void pickAvatar()}>
              <Text className="text-sm font-semibold">{t(busy === 'avatar' ? 'uploading' : 'changeAvatar')}</Text>
            </Button>
            {user?.avatar ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy !== null}
                onPress={() => void run('avatar', () => update({ remove: ['Avatar'] }))}
              >
                <Text className="text-sm font-semibold text-destructive">{t('removeAvatar')}</Text>
              </Button>
            ) : null}
          </View>
        </View>

        <View className="gap-2">
          <Text className="font-medium">{t('displayName')}</Text>
          <Input
            value={name}
            onChangeText={(value) => {
              setName(value)
              setSaved(false)
            }}
            placeholder={user?.username}
            maxLength={32}
          />
          <Text className="text-xs text-muted-foreground">{t('displayNameHint')}</Text>
        </View>

        {error ? <Text className="text-destructive">{error}</Text> : null}
        {saved ? <Text className="text-success">{t('saved')}</Text> : null}

        <Button
          size="lg"
          disabled={!nameChanged || busy !== null}
          onPress={() =>
            void run('name', () => update(trimmed ? { display_name: trimmed } : { remove: ['DisplayName'] }))
          }
        >
          <Text className="font-semibold text-primary-foreground">{t('save')}</Text>
        </Button>
      </ScrollView>
    </View>
  )
}
