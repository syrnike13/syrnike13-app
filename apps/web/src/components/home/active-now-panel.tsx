import type { User } from '@syrnike13/api-types'

import { UserAvatar } from '#/components/user/user-avatar'
import { getUserPresence, isUserOnline, presenceModeLabel } from '#/lib/presence'

type ActiveNowPanelProps = {
  users?: User[]
}

function userLabel(user: User) {
  return user.display_name ?? user.username
}

export function ActiveNowPanel({ users = [] }: ActiveNowPanelProps) {
  const activeUsers = users.filter(isUserOnline)

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-l border-shell-divider bg-card xl:flex">
      <header className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Сейчас активны</h2>
      </header>
      {activeUsers.length > 0 ? (
        <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
          {activeUsers.map((user) => {
            const customStatus = user.status?.text?.trim()

            return (
              <article
                key={user._id}
                className="rounded-lg border border-border bg-background/60 p-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <UserAvatar
                    user={user}
                    className="size-9"
                    fallbackClassName="size-9 text-xs"
                    showPresence
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {userLabel(user)}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {presenceModeLabel(getUserPresence(user))}
                    </p>
                  </div>
                </div>
                {customStatus ? (
                  <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
                    {customStatus}
                  </p>
                ) : null}
              </article>
            )
          })}
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <p className="text-sm font-medium text-muted-foreground">
            Тут пока тихо
          </p>
          <p className="text-xs text-muted-foreground">
            Когда друзья будут в сети, они появятся здесь.
          </p>
        </div>
      )}
    </aside>
  )
}
