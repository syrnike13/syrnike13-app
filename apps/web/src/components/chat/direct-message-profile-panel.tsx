import type { User } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'

import { UserProfileHeader } from '#/components/user/user-profile-header'
import { UserProfileIdentity } from '#/components/user/user-profile-identity'
import { useUserMutuals } from '#/components/user/use-user-mutuals'
import { useUserProfileData } from '#/components/user/use-user-profile-data'
import { useMutualServerMembersSync } from '#/features/sync/mutual-server-members-sync'

export const DM_PROFILE_PANEL_DEFAULT_SIZE = '320px'
export const DM_PROFILE_PANEL_MIN_SIZE = '280px'
export const DM_PROFILE_PANEL_MAX_SIZE = '440px'

type DirectMessageProfilePanelProps = {
  user: User
  currentUserId?: string
  token?: string | null
  aliases: string[]
  onOpenProfile?: () => void
}

export function DirectMessageProfilePanel({
  user,
  currentUserId,
  token,
  aliases,
  onOpenProfile,
}: DirectMessageProfilePanelProps) {
  const t = useTranslations('chat')
  const tu = useTranslations('users')
  useMutualServerMembersSync(user._id, currentUserId, token)
  const { bio } = useUserProfileData(user._id)
  const { mutualServers } = useUserMutuals(user._id)

  return (
    <aside
      aria-label={t('profileLabel')}
      className="theme-surface-content gradient-surface-content flex h-full min-h-0 w-full min-w-0 flex-col overflow-y-auto border-l border-shell-divider text-card-foreground"
    >
      <UserProfileHeader
        user={user}
        variant="panel"
        onAvatarClick={onOpenProfile}
      />

      <div className="flex min-w-0 flex-col gap-4 px-4 pt-1 pb-6">
        <UserProfileIdentity user={user} />

        {bio ? (
          <section>
            <h3 className="mb-1.5 text-xs leading-4 font-medium text-muted-foreground">
              {t('about')}
            </h3>
            <p className="text-sm leading-4.5 whitespace-pre-wrap text-foreground">
              {bio}
            </p>
          </section>
        ) : null}

        {aliases.length > 0 ? (
          <section>
            <h3 className="mb-1.5 text-xs leading-4 font-medium text-muted-foreground">
              {tu('aka')}
            </h3>
            <p className="truncate text-sm leading-4.5 font-medium text-foreground">
              {aliases.join(', ')}
            </p>
          </section>
        ) : null}

        <section>
          <h3 className="mb-1.5 text-xs leading-4 font-medium text-muted-foreground">
            {t('mutualServers', { count: mutualServers.length })}
          </h3>
          <p className="text-sm leading-4.5 text-muted-foreground">
            {mutualServers.length > 0
              ? mutualServers.map((server) => server.name).join(', ')
              : t('noMutualServers')}
          </p>
        </section>
      </div>
    </aside>
  )
}
