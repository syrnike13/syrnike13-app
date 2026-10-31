import type { InviteResponse } from '@syrnike13/api-types'
import {
  fetchPublicInviteEffect,
  isGroupInviteJoin,
  isServerInviteJoin,
  joinInviteEffect,
} from '@syrnike13/client/api/invites-api'
import { syncStore, useSyncStore } from '@syrnike13/client/sync/sync-store'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Avatar } from '@syrnike13/ui-native/primitives/avatar'
import { Button } from '@syrnike13/ui-native/primitives/button'
import { Text } from '@syrnike13/ui-native/primitives/text'
import { Effect } from 'effect'
import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import { View } from 'react-native'

import { useSession } from '../auth/session-context'
import { XIcon } from '../components/icons/registry'
import { mediaUrl } from '../lib/media'

/** Leaves the invite for the server's home or the group chat. */
function openServer(serverId: string) {
  syncStore.setSelectedServerId(serverId)
  router.replace('/')
}

/**
 * An invite link opened in the app: who invites you where, the member count,
 * and a join button (or "open" when you are already in that server).
 */
export function InviteScreen({ code }: { code: string }) {
  const t = useTranslations('mobile.invite')
  const { session } = useSession()
  const [invite, setInvite] = useState<InviteResponse | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'invalid' | 'joining' | 'failed'>('loading')
  const joined = useSyncStore((store) =>
    invite?.type === 'Server' ? Boolean(store.servers[invite.server_id]) : false,
  )

  useEffect(() => {
    let cancelled = false
    Effect.runPromise(fetchPublicInviteEffect(code)).then(
      (value) => {
        if (cancelled) return
        setInvite(value)
        setState('ready')
      },
      () => !cancelled && setState('invalid'),
    )
    return () => {
      cancelled = true
    }
  }, [code])

  async function join() {
    if (invite?.type === 'Server' && joined) return openServer(invite.server_id)
    setState('joining')
    try {
      const response = await Effect.runPromise(joinInviteEffect(session.token, code))
      syncStore.applyInviteJoinResponse(response)
      if (isServerInviteJoin(response)) openServer(response.server._id)
      else if (isGroupInviteJoin(response)) router.replace(`/channel/${response.channel._id}`)
    } catch {
      setState('failed')
    }
  }

  const name = invite?.type === 'Server' ? invite.server_name : invite?.channel_name
  const icon = invite?.type === 'Server' ? invite.server_icon : invite?.user_avatar

  return (
    <View className="flex-1 bg-background">
      <View className="h-14 flex-row items-center px-2">
        <Button variant="ghost" size="icon-lg" accessibilityLabel={t('close')} onPress={() => router.replace('/')}>
          <XIcon size={24} />
        </Button>
      </View>
      <View className="flex-1 items-center justify-center gap-3 px-6 pb-16">
        {state === 'loading' ? (
          <Text className="text-muted-foreground">{t('loading')}</Text>
        ) : state === 'invalid' || !invite ? (
          <>
            <Text className="text-center text-2xl font-bold">{t('invalidTitle')}</Text>
            <Text className="text-center text-muted-foreground">{t('invalidDescription')}</Text>
          </>
        ) : (
          <>
            <Avatar size="2xl" src={mediaUrl(icon)} name={name ?? ''} />
            <Text className="text-center text-muted-foreground">{t('invitedBy', { name: invite.user_name })}</Text>
            <Text className="text-center text-3xl font-bold">{name}</Text>
            {invite.type === 'Server' ? (
              <Text className="text-muted-foreground">{t('members', { count: invite.member_count })}</Text>
            ) : null}
            {state === 'failed' ? <Text className="text-destructive">{t('joinFailed')}</Text> : null}
            <Button
              variant="success"
              size="lg"
              className="mt-4 w-full"
              disabled={state === 'joining'}
              onPress={() => void join()}
            >
              <Text className="font-semibold">{t(joined ? 'open' : 'join')}</Text>
            </Button>
          </>
        )}
      </View>
    </View>
  )
}
