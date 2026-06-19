import { useAuth } from '#/features/auth/auth-context'
import { EMPTY_TYPING_USERS } from '#/features/sync/selectors'
import { useSyncStore } from '#/features/sync/sync-store'

import { cn } from '#/lib/utils'

type TypingIndicatorProps = {
  channelId: string
  floating?: boolean
}

export function TypingIndicator({
  channelId,
  floating = false,
}: TypingIndicatorProps) {
  const auth = useAuth()
  const users = useSyncStore((s) => s.users)
  const typingUserIds = useSyncStore(
    (s) => s.typingUsers[channelId] ?? EMPTY_TYPING_USERS,
  )

  const others = typingUserIds.filter((id) => id !== auth.user?._id)
  if (others.length === 0) return null

  const labels = others.map((userId) => {
    const user = users[userId]
    return user?.display_name ?? user?.username ?? 'Кто-то'
  })

  let text: string
  if (labels.length === 1) {
    text = `${labels[0]} печатает…`
  } else if (labels.length === 2) {
    text = `${labels[0]} и ${labels[1]} печатают…`
  } else {
    text = 'Несколько человек печатают…'
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
