import { useTranslations } from '@syrnike13/ui/i18n'

import { SettingsBlock, SettingsToggleRow } from '#/components/settings/settings-panels'
import { usePrivacy } from '#/features/privacy/use-privacy'
import { listServers } from '@syrnike13/client/sync/selectors'
import { useSyncStore } from '@syrnike13/client/sync/sync-store'

export function SettingsPrivacyPanel() {
  const t = useTranslations('settings.privacy')
  const { privacy, loaded, update } = usePrivacy()
  const serverIds = useSyncStore((state) =>
    listServers(state).map((server) => server._id),
  )
  const friendRequests = privacy.friend_requests

  return (
    <>
      <SettingsBlock title={t('directMessages')}>
        <SettingsToggleRow
          label={t('serverDms')}
          hint={t('serverDmsHint')}
          checked={!privacy.restrict_dms_in_new_servers}
          disabled={!loaded}
          onCheckedChange={(allowed) =>
            update({
              ...privacy,
              restrict_dms_in_new_servers: !allowed,
              dm_restricted_servers: allowed ? [] : serverIds,
            })
          }
        />
      </SettingsBlock>

      <SettingsBlock
        title={t('friendRequests')}
        description={t('friendRequestsHint')}
      >
        <SettingsToggleRow
          label={t('friendRequestsEveryone')}
          checked={friendRequests.everyone}
          disabled={!loaded}
          onCheckedChange={(everyone) =>
            update({
              ...privacy,
              friend_requests: { ...friendRequests, everyone },
            })
          }
        />
        <SettingsToggleRow
          label={t('friendRequestsFriendsOfFriends')}
          checked={friendRequests.everyone || friendRequests.friends_of_friends}
          disabled={!loaded || friendRequests.everyone}
          onCheckedChange={(friendsOfFriends) =>
            update({
              ...privacy,
              friend_requests: {
                ...friendRequests,
                friends_of_friends: friendsOfFriends,
              },
            })
          }
        />
        <SettingsToggleRow
          label={t('friendRequestsServerMembers')}
          checked={friendRequests.everyone || friendRequests.server_members}
          disabled={!loaded || friendRequests.everyone}
          onCheckedChange={(serverMembers) =>
            update({
              ...privacy,
              friend_requests: {
                ...friendRequests,
                server_members: serverMembers,
              },
            })
          }
        />
      </SettingsBlock>
    </>
  )
}
