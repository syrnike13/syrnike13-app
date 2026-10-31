import type { Server } from '@syrnike13/api-types'
import { createChannelInviteEffect } from '@syrnike13/client/api/invites-api'
import { deleteOrLeaveServerEffect } from '@syrnike13/client/api/servers-api'
import { syncStore } from '@syrnike13/client/sync/sync-store'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Avatar } from '@syrnike13/ui-native/primitives/avatar'
import { Button } from '@syrnike13/ui-native/primitives/button'
import { Sheet, SheetGroup, SheetItem } from '@syrnike13/ui-native/primitives/sheet'
import { Text } from '@syrnike13/ui-native/primitives/text'
import { Effect } from 'effect'
import * as Clipboard from 'expo-clipboard'
import { useEffect, useState } from 'react'
import { Share, View } from 'react-native'

import { useSession } from '../auth/session-context'
import { CopyIcon, LogOutIcon, UserPlusIcon } from '../components/icons/registry'
import { APP_URL } from '../config'
import { mediaUrl } from '../lib/media'

/**
 * Server info from the name in the panel header: icon, name, description,
 * then invite and, unless you own it, leave (asked again in the sheet). The
 * owner is never offered "leave": the same request deletes an owner's server.
 */
export function ServerInfoSheet({
  server,
  onClose,
  onInvite,
}: {
  server: Server
  onClose: () => void
  onInvite: () => void
}) {
  const t = useTranslations('mobile.server')
  const { session } = useSession()
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const owner = server.owner === session.userId

  async function leave() {
    setLeaving(true)
    try {
      await Effect.runPromise(deleteOrLeaveServerEffect(session.token, server._id))
      syncStore.setSelectedServerId(null)
      onClose()
    } catch {
      setLeaving(false)
    }
  }

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()} closeLabel={t('close')}>
      {confirmLeave ? (
        <View className="gap-4 px-4 pb-2">
          <Text className="text-lg font-semibold">{t('leaveTitle', { name: server.name })}</Text>
          <Text className="text-muted-foreground">{t('leaveDescription')}</Text>
          <Button variant="destructive" size="lg" disabled={leaving} onPress={() => void leave()}>
            <Text className="font-semibold text-destructive">{t('leave')}</Text>
          </Button>
          <Button variant="secondary" size="lg" onPress={() => setConfirmLeave(false)}>
            <Text className="font-semibold">{t('cancel')}</Text>
          </Button>
        </View>
      ) : (
        <View className="gap-4">
          <View className="gap-2 px-4">
            <Avatar size="xl" src={mediaUrl(server.icon)} name={server.name} />
            <Text className="text-2xl font-bold">{server.name}</Text>
            {server.description ? <Text className="text-muted-foreground">{server.description}</Text> : null}
          </View>
          <SheetGroup>
            <SheetItem
              onPress={() => {
                onClose()
                onInvite()
              }}
            >
              <UserPlusIcon size={20} className="text-muted-foreground" />
              <Text>{t('invite')}</Text>
            </SheetItem>
            {owner ? null : (
              <SheetItem destructive onPress={() => setConfirmLeave(true)}>
                <LogOutIcon size={20} className="text-destructive" />
                <Text>{t('leave')}</Text>
              </SheetItem>
            )}
          </SheetGroup>
        </View>
      )}
    </Sheet>
  )
}

/**
 * Creates an invite to the server's first text channel and offers the link
 * to copy or share. Without the invite permission the server refuses and the
 * sheet says so.
 */
export function InviteSheet({
  server,
  channelId,
  onClose,
}: {
  server: Server
  channelId: string | undefined
  onClose: () => void
}) {
  const t = useTranslations('mobile.server')
  const { session } = useSession()
  const [link, setLink] = useState<string | null>(null)
  const [failed, setFailed] = useState(!channelId)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!channelId) return
    let cancelled = false
    Effect.runPromise(createChannelInviteEffect(session.token, channelId)).then(
      (invite) => {
        if (!cancelled) setLink(`${APP_URL}/invite/${invite._id}`)
      },
      () => {
        if (!cancelled) setFailed(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [channelId, session.token])

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()} closeLabel={t('close')}>
      <View className="gap-4 px-4 pb-2">
        <Text className="text-lg font-semibold">{t('inviteTitle', { name: server.name })}</Text>
        {failed ? (
          <Text className="text-destructive">{t('inviteFailed')}</Text>
        ) : (
          <View className="h-11 justify-center rounded-lg bg-card px-3">
            <Text className={link ? 'font-medium' : 'text-muted-foreground'} numberOfLines={1} selectable>
              {link ?? t('inviteCreating')}
            </Text>
          </View>
        )}
        <View className="flex-row gap-2">
          <Button
            variant="secondary"
            size="lg"
            className="flex-1"
            disabled={!link}
            onPress={() => {
              if (!link) return
              void Clipboard.setStringAsync(link).then(() => setCopied(true))
            }}
          >
            <CopyIcon size={18} />
            <Text className="font-semibold">{t(copied ? 'copied' : 'copy')}</Text>
          </Button>
          <Button
            size="lg"
            className="flex-1"
            disabled={!link}
            onPress={() => link && void Share.share({ message: link, url: link }).catch(() => {})}
          >
            <Text className="font-semibold text-primary-foreground">{t('share')}</Text>
          </Button>
        </View>
      </View>
    </Sheet>
  )
}
