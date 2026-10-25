import { useQuery } from '@tanstack/react-query'

import { SettingsProfileStatusDialog } from '#/components/settings/settings-profile-status-dialog'
import { useAuth } from '#/features/auth/auth-context'
import { fetchUserProfile } from '#/features/api/users-api'
import { useSetCustomStatus } from '#/features/users/use-set-custom-status'
import { queryKeys } from '#/lib/api/query-keys'
import { userAvatarUrl, userBannerUrl } from '#/lib/media'

/** Custom status editor for the signed-in user (profile menu, mobile profile). */
export function CurrentUserStatusDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const auth = useAuth()
  const user = auth.user
  const token = auth.session?.token
  const { setCustomStatus } = useSetCustomStatus()

  const profileQuery = useQuery({
    queryKey: queryKeys.users.profile(user?._id ?? ''),
    queryFn: ({ signal }) => fetchUserProfile(token!, user!._id, signal),
    enabled: Boolean(open && token && user),
    staleTime: 60_000,
  })

  if (!user) return null

  return (
    <SettingsProfileStatusDialog
      open={open}
      onOpenChange={onOpenChange}
      statusText={user.status?.text?.trim() ?? ''}
      onApply={(text) => void setCustomStatus(text)}
      user={user}
      displayName={user.display_name ?? user.username}
      username={user.username}
      avatarUrl={userAvatarUrl(user.avatar, { animated: true })}
      bannerUrl={userBannerUrl(profileQuery.data?.background, {
        animated: true,
      })}
    />
  )
}
