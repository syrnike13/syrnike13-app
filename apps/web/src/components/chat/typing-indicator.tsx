import { useTranslations } from '@syrnike13/ui/i18n'

import { useAuth } from '#/features/auth/auth-context'
import { EMPTY_TYPING_USERS } from '@syrnike13/client/sync/selectors'
import { useSyncStore } from '@syrnike13/client/sync/sync-store'

import { cn } from '#/lib/utils'

type TypingIndicatorProps = {
  channelId: string
  floating?: boolean
}

export function TypingIndicator({
  channelId,
  floating = false,
}: TypingIndicatorProps) {
  const t = useTranslations('chat.typing')
  const auth = useAuth()
  const users = useSyncStore((s) => s.users)
  const typingUserIds = useSyncStore(
    (s) => s.typingUsers[channelId] ?? EMPTY_TYPING_USERS,
  )

  const others = typingUserIds.filter((id) => id !== auth.user?._id)
  if (others.length === 0) return null

  const labels = others.map((userId) => {
    const user = users[userId]
    return user?.display_name ?? user?.username ?? t('someone')
  })

  let text: string
  if (labels.length === 1) {
    text = t('one', { name: labels[0] })
  } else if (labels.length === 2) {
    text = t('two', { first: labels[0], second: labels[1] })
  } else {
    text = t('many')
  }

  return (
    <p
      className={cn(
        'text-xs text-muted-foreground',
        floating
          ? 'pointer-events-auto self-start rounded-md bg-card/95 px-2 py-1 shadow-sm ring-1 ring-shell-divider backdrop-blur-sm'
          : 'border-t px-4 py-2',
      )}
    >
      {text}
    </p>
  )
}
