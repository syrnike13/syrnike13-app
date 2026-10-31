import type { Message as ApiMessage } from '@syrnike13/api-types'
import {
  deleteChannelMessageEffect,
  reactToMessageEffect,
  unreactFromMessageEffect,
} from '@syrnike13/client/api/messages-api'
import { QUICK_REACTIONS } from '@syrnike13/client/lib/reactions'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Button } from '@syrnike13/ui-native/primitives/button'
import { Sheet, SheetGroup, SheetItem } from '@syrnike13/ui-native/primitives/sheet'
import { Text } from '@syrnike13/ui-native/primitives/text'
import { Effect } from 'effect'
import * as Clipboard from 'expo-clipboard'
import { useState } from 'react'
import { View } from 'react-native'

import { useSession } from '../auth/session-context'
import { CopyIcon, PencilIcon, ReplyIcon, Trash2Icon } from '../components/icons/registry'

/** Discord mobile shows six quick reactions above the actions. */
const SHEET_REACTIONS = QUICK_REACTIONS.slice(0, 6)

/**
 * Long-press menu of a message: quick reactions, then reply, copy, and for
 * your own messages edit and delete (delete asks again in the same sheet).
 */
export function MessageActionsSheet({
  message,
  onClose,
  onReply,
  onEdit,
}: {
  message: ApiMessage
  onClose: () => void
  onReply: (message: ApiMessage) => void
  onEdit: (message: ApiMessage) => void
}) {
  const t = useTranslations('mobile.chat.actions')
  const { session } = useSession()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const own = message.author === session.userId
  const text = message.content?.trim()

  function run(action: () => void) {
    return () => {
      onClose()
      action()
    }
  }

  function react(emoji: string) {
    const reacted = message.reactions?.[emoji]?.includes(session.userId) ?? false
    const request = reacted ? unreactFromMessageEffect : reactToMessageEffect
    Effect.runFork(request(session.token, message.channel, message._id, emoji).pipe(Effect.ignore))
  }

  function remove() {
    // The gateway's MessageDelete event removes it from the feed.
    Effect.runFork(deleteChannelMessageEffect(session.token, message.channel, message._id).pipe(Effect.ignore))
  }

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()} closeLabel={t('close')}>
      {confirmDelete ? (
        <View className="gap-4 px-4 pb-2">
          <Text className="text-lg font-semibold">{t('deleteTitle')}</Text>
          <Text className="text-muted-foreground">{t('deleteDescription')}</Text>
          <Button variant="destructive" size="lg" onPress={run(remove)}>
            <Text className="font-semibold text-destructive">{t('delete')}</Text>
          </Button>
          <Button variant="secondary" size="lg" onPress={() => setConfirmDelete(false)}>
            <Text className="font-semibold">{t('cancel')}</Text>
          </Button>
        </View>
      ) : (
        <View className="gap-4">
          <View className="flex-row justify-between px-4">
            {SHEET_REACTIONS.map((emoji) => (
              <Button
                key={emoji}
                variant="secondary"
                size="icon-xl"
                shape="circle"
                accessibilityLabel={t('react', { emoji })}
                onPress={run(() => react(emoji))}
              >
                <Text className="text-2xl">{emoji}</Text>
              </Button>
            ))}
          </View>
          <SheetGroup>
            <SheetItem onPress={run(() => onReply(message))}>
              <ReplyIcon size={20} className="text-muted-foreground" />
              <Text>{t('reply')}</Text>
            </SheetItem>
            {text ? (
              <SheetItem onPress={run(() => void Clipboard.setStringAsync(text))}>
                <CopyIcon size={20} className="text-muted-foreground" />
                <Text>{t('copyText')}</Text>
              </SheetItem>
            ) : null}
            {own && text ? (
              <SheetItem onPress={run(() => onEdit(message))}>
                <PencilIcon size={20} className="text-muted-foreground" />
                <Text>{t('edit')}</Text>
              </SheetItem>
            ) : null}
            {own ? (
              <SheetItem destructive onPress={() => setConfirmDelete(true)}>
                <Trash2Icon size={20} className="text-destructive" />
                <Text>{t('delete')}</Text>
              </SheetItem>
            ) : null}
          </SheetGroup>
        </View>
      )}
    </Sheet>
  )
}
