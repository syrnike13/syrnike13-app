import type { ManualPresence, User } from '@syrnike13/api-types'
import { updateCurrentUserEffect } from '@syrnike13/client/api/users-api'
import { syncStore } from '@syrnike13/client/sync/sync-store'
import { useTranslations } from '@syrnike13/ui/i18n'
import { cn } from '@syrnike13/ui-native/lib/cn'
import { Button } from '@syrnike13/ui-native/primitives/button'
import { Input } from '@syrnike13/ui-native/primitives/input'
import { Sheet, SheetGroup, SheetItem } from '@syrnike13/ui-native/primitives/sheet'
import { Text } from '@syrnike13/ui-native/primitives/text'
import { Effect } from 'effect'
import { useState } from 'react'
import { View } from 'react-native'

import { useSession } from '../auth/session-context'
import { CheckIcon } from '../components/icons/registry'

/** Discord's four presences; the web's Focus shows here like Do Not Disturb. */
export const PRESENCES: { value: ManualPresence; dot: string }[] = [
  { value: 'Online', dot: 'bg-success' },
  { value: 'Idle', dot: 'bg-warning' },
  { value: 'Busy', dot: 'bg-destructive' },
  { value: 'Invisible', dot: 'bg-muted-foreground' },
]

/**
 * The presence you chose, as one of the four above. System presences (idle
 * or online detected by a client) and Focus are not choices here.
 */
export function chosenPresence(user: User | undefined): ManualPresence {
  const presence = user?.status?.presence
  if (presence === 'Focus') return 'Busy'
  return PRESENCES.some((option) => option.value === presence) ? (presence as ManualPresence) : 'Online'
}

const MANUAL: readonly string[] = ['Online', 'Idle', 'Focus', 'Busy', 'Invisible']

function keptPresence(user: User | undefined): ManualPresence {
  const presence = user?.status?.presence
  return presence && MANUAL.includes(presence) ? (presence as ManualPresence) : 'Online'
}

/** Saves the status and keeps the store's copy of you in step. */
function useUpdateStatus() {
  const { session } = useSession()
  return (status: { presence?: ManualPresence; text?: string }, user: User | undefined) =>
    Effect.runPromise(
      updateCurrentUserEffect(
        session.token,
        status.text === ''
          ? { remove: ['StatusText'] }
          : {
              status: {
                // Changing only the text keeps any manual presence, Focus included.
                presence: status.presence ?? keptPresence(user),
                text: status.text ?? user?.status?.text ?? null,
              },
            },
      ),
    ).then((updated) => syncStore.upsertUser(updated))
}

/** Presence picker plus the custom status line, from the status card. */
export function StatusSheet({ user, onClose }: { user: User | undefined; onClose: () => void }) {
  const t = useTranslations('mobile.status')
  const update = useUpdateStatus()
  const current = chosenPresence(user)
  const [text, setText] = useState(user?.status?.text ?? '')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  async function save(status: { presence?: ManualPresence; text?: string }) {
    setSaving(true)
    setFailed(false)
    try {
      await update(status, user)
      onClose()
    } catch {
      setFailed(true)
      setSaving(false)
    }
  }

  const textChanged = text.trim() !== (user?.status?.text ?? '')

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()} closeLabel={t('close')}>
      <View className="gap-4">
        <View className="gap-2 px-4">
          <Text className="font-medium">{t('custom')}</Text>
          <Input value={text} onChangeText={setText} placeholder={t('customPlaceholder')} maxLength={128} />
          {textChanged ? (
            <Button disabled={saving} onPress={() => void save({ text: text.trim() })}>
              <Text className="font-semibold text-primary-foreground">{t(text.trim() ? 'save' : 'clear')}</Text>
            </Button>
          ) : null}
        </View>
        <SheetGroup>
          {PRESENCES.map((option) => (
            <SheetItem key={option.value} disabled={saving} onPress={() => void save({ presence: option.value })}>
              <View className={cn('size-3 rounded-full', option.dot)} />
              <Text className="flex-1">{t(`presence.${option.value}`)}</Text>
              {current === option.value ? <CheckIcon size={20} className="text-primary" /> : null}
            </SheetItem>
          ))}
        </SheetGroup>
        {failed ? <Text className="px-4 text-destructive">{t('failed')}</Text> : null}
      </View>
    </Sheet>
  )
}
