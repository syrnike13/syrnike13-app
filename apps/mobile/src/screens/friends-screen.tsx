import type { User } from '@syrnike13/api-types'
import {
  acceptFriendRequestEffect,
  removeFriendOrRequestEffect,
  sendFriendRequestEffect,
} from '@syrnike13/client/api/users-api'
import { syncStore } from '@syrnike13/client/sync/sync-store'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Avatar } from '@syrnike13/ui-native/primitives/avatar'
import { Button } from '@syrnike13/ui-native/primitives/button'
import { Input } from '@syrnike13/ui-native/primitives/input'
import { Text } from '@syrnike13/ui-native/primitives/text'
import { Effect } from 'effect'
import { router } from 'expo-router'
import { useState, type ReactNode } from 'react'
import { Pressable, ScrollView, View } from 'react-native'

import { useSession } from '../auth/session-context'
import { ArrowLeftIcon, CheckIcon, MessageCircleIcon, XIcon } from '../components/icons/registry'
import { useOpenDirectMessage, useUsersByRelationship } from '../lib/direct-messages'
import { mediaUrl } from '../lib/media'
import { displayName, userStatus } from '../lib/presence'

/** Friend actions return the updated user; the store keeps the lists current. */
function runFriendAction(request: Effect.Effect<User, unknown>) {
  return Effect.runPromise(request).then((user) => syncStore.upsertUser(user))
}

/**
 * Friends, opened from "Add friends" on the DM home: add by username,
 * answer requests, and open a DM with any friend.
 */
export function FriendsScreen() {
  const t = useTranslations('mobile.friends')
  const incoming = useUsersByRelationship('Incoming')
  const outgoing = useUsersByRelationship('Outgoing')
  const friends = useUsersByRelationship('Friend')
  const openDm = useOpenDirectMessage()

  return (
    <View className="flex-1 bg-background">
      <View className="h-14 flex-row items-center gap-2 border-b border-border pr-4 pl-2">
        <Button variant="ghost" size="icon-lg" accessibilityLabel={t('back')} onPress={() => router.back()}>
          <ArrowLeftIcon size={24} />
        </Button>
        <Text className="text-2xl font-bold">{t('title')}</Text>
      </View>
      <ScrollView contentContainerClassName="gap-6 py-4 pb-12">
        <AddFriend />
        {incoming.length + outgoing.length > 0 ? (
          <Section title={t('requests', { count: incoming.length + outgoing.length })}>
            {incoming.map((user) => (
              <UserRow key={user._id} user={user} subtitle={t('incoming')}>
                <ActionButton
                  label={t('accept', { name: displayName(user) })}
                  icon={<CheckIcon size={20} className="text-success" />}
                  request={(token) => acceptFriendRequestEffect(token, user._id)}
                />
                <ActionButton
                  label={t('decline', { name: displayName(user) })}
                  icon={<XIcon size={20} className="text-destructive" />}
                  request={(token) => removeFriendOrRequestEffect(token, user._id)}
                />
              </UserRow>
            ))}
            {outgoing.map((user) => (
              <UserRow key={user._id} user={user} subtitle={t('outgoing')}>
                <ActionButton
                  label={t('cancelRequest', { name: displayName(user) })}
                  icon={<XIcon size={20} className="text-muted-foreground" />}
                  request={(token) => removeFriendOrRequestEffect(token, user._id)}
                />
              </UserRow>
            ))}
          </Section>
        ) : null}
        <Section title={t('all', { count: friends.length })}>
          {friends.length === 0 ? (
            <Text className="px-4 text-muted-foreground">{t('empty')}</Text>
          ) : (
            friends.map((user) => (
              <UserRow key={user._id} user={user} onPress={() => void openDm(user._id)}>
                <View className="size-9 items-center justify-center rounded-full bg-secondary">
                  <MessageCircleIcon size={18} className="text-muted-foreground" />
                </View>
              </UserRow>
            ))
          )}
        </Section>
      </ScrollView>
    </View>
  )
}

/** "Add by username": the request goes out as typed, like on the web. */
function AddFriend() {
  const t = useTranslations('mobile.friends')
  const { session } = useSession()
  const [username, setUsername] = useState('')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<'sent' | 'failed' | null>(null)

  async function send() {
    const value = username.trim()
    if (!value) return
    setSending(true)
    setResult(null)
    try {
      await runFriendAction(sendFriendRequestEffect(session.token, value))
      setUsername('')
      setResult('sent')
    } catch {
      setResult('failed')
    } finally {
      setSending(false)
    }
  }

  return (
    <View className="gap-2 px-4">
      <Text className="text-lg font-semibold">{t('addTitle')}</Text>
      <Text className="text-muted-foreground">{t('addDescription')}</Text>
      <Input
        value={username}
        onChangeText={(value) => {
          setUsername(value)
          setResult(null)
        }}
        placeholder={t('usernamePlaceholder')}
        autoCapitalize="none"
        autoCorrect={false}
        onSubmitEditing={() => void send()}
      />
      {result ? (
        <Text className={result === 'sent' ? 'text-sm text-success' : 'text-sm text-destructive'}>
          {t(result === 'sent' ? 'requestSent' : 'requestFailed')}
        </Text>
      ) : null}
      <Button disabled={!username.trim() || sending} onPress={() => void send()}>
        <Text className="font-semibold text-primary-foreground">{t('send')}</Text>
      </Button>
    </View>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className="gap-1">
      <Text className="px-4 pb-1 text-sm font-medium text-muted-foreground">{title}</Text>
      {children}
    </View>
  )
}

function UserRow({
  user,
  subtitle,
  onPress,
  children,
}: {
  user: User
  subtitle?: string
  onPress?: () => void
  children?: ReactNode
}) {
  const name = displayName(user)
  return (
    <Pressable
      disabled={!onPress}
      onPress={onPress}
      className="mx-2 h-14 flex-row items-center gap-3 rounded-xl px-2 active:bg-hover"
    >
      <Avatar size="lg" src={mediaUrl(user.avatar)} name={name} status={userStatus(user)} />
      <View className="min-w-0 flex-1">
        <Text className="font-medium" numberOfLines={1}>
          {name}
        </Text>
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {subtitle ?? user.username}
        </Text>
      </View>
      {children}
    </Pressable>
  )
}

function ActionButton({
  label,
  icon,
  request,
}: {
  label: string
  icon: ReactNode
  request: (token: string) => Effect.Effect<User, unknown>
}) {
  const { session } = useSession()
  const [busy, setBusy] = useState(false)
  return (
    <Button
      variant="secondary"
      size="icon-lg"
      shape="circle"
      accessibilityLabel={label}
      disabled={busy}
      onPress={() => {
        setBusy(true)
        runFriendAction(request(session.token))
          .catch(() => {})
          .finally(() => setBusy(false))
      }}
    >
      {icon}
    </Button>
  )
}
