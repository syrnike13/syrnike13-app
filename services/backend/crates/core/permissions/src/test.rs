use crate::{
    calculate_channel_permissions, calculate_server_permissions, calculate_user_permissions,
    ChannelPermission, ChannelType, Override, PermissionQuery, RelationshipStatus, UserPermission,
    DEFAULT_PERMISSION_DIRECT_MESSAGE, DEFAULT_PERMISSION_SERVER, DEFAULT_PERMISSION_VIEW_ONLY,
};

#[async_std::test]
async fn validate_user_permissions() {
    /// Scenario in which we are friends with a user
    /// and we have a DM channel open with them
    struct Scenario {}
    let mut query = Scenario {};

    let perms = calculate_user_permissions(&mut query).await;
    assert!(perms.has_user_permission(UserPermission::Access));
    assert!(perms.has_user_permission(UserPermission::ViewProfile));
    assert!(perms.has_user_permission(UserPermission::SendMessage));
    assert!(perms.has_user_permission(UserPermission::Invite));

    let perms = calculate_channel_permissions(&mut query).await;
    let value: u64 = perms.into();
    assert_eq!(value, *DEFAULT_PERMISSION_DIRECT_MESSAGE);

    #[async_trait]
    impl PermissionQuery for Scenario {
        async fn are_we_a_bot(&mut self) -> bool {
            false
        }

        async fn are_the_users_same(&mut self) -> bool {
            false
        }

        async fn user_relationship(&mut self) -> RelationshipStatus {
            RelationshipStatus::Friend
        }

        async fn user_is_bot(&mut self) -> bool {
            false
        }

        async fn have_mutual_connection(&mut self) -> bool {
            false
        }

        async fn are_we_server_owner(&mut self) -> bool {
            unreachable!()
        }

        async fn are_we_a_member(&mut self) -> bool {
            unreachable!()
        }

        async fn get_default_server_permissions(&mut self) -> u64 {
            unreachable!()
        }

        async fn get_our_server_role_overrides(&mut self) -> Vec<Override> {
            unreachable!()
        }

        async fn are_we_timed_out(&mut self) -> bool {
            unreachable!()
        }

        async fn do_we_have_publish_overwrites(&mut self) -> bool {
            true
        }

        async fn do_we_have_receive_overwrites(&mut self) -> bool {
            true
        }

        async fn get_channel_type(&mut self) -> ChannelType {
            ChannelType::DirectMessage
        }

        async fn get_default_channel_permissions(&mut self) -> Override {
            unreachable!()
        }

        async fn get_our_channel_role_overrides(&mut self) -> Vec<Override> {
            unreachable!()
        }

        async fn get_our_channel_user_override(&mut self) -> Option<Override> {
            unreachable!()
        }

        async fn do_we_own_the_channel(&mut self) -> bool {
            unreachable!()
        }

        async fn are_we_part_of_the_channel(&mut self) -> bool {
            true
        }

        async fn have_voice_channel_membership(&mut self) -> bool {
            false
        }

        async fn set_recipient_as_user(&mut self) {
            // no-op
        }

        async fn set_server_from_channel(&mut self) {
            unreachable!()
        }
    }
}

#[async_std::test]
async fn validate_group_permissions() {
    /// Scenario in which we are in a group channel with only talking permission
    struct Scenario {}
    let mut query = Scenario {};

    let perms = calculate_channel_permissions(&mut query).await;
    let value: u64 = perms.into();
    assert_eq!(
        value,
        *DEFAULT_PERMISSION_VIEW_ONLY | ChannelPermission::SendMessage as u64
    );

    #[async_trait]
    impl PermissionQuery for Scenario {
        async fn are_we_a_bot(&mut self) -> bool {
            unreachable!()
        }

        async fn are_the_users_same(&mut self) -> bool {
            unreachable!()
        }

        async fn user_relationship(&mut self) -> RelationshipStatus {
            unreachable!()
        }

        async fn user_is_bot(&mut self) -> bool {
            unreachable!()
        }

        async fn have_mutual_connection(&mut self) -> bool {
            unreachable!()
        }

        async fn are_we_server_owner(&mut self) -> bool {
            unreachable!()
        }

        async fn are_we_a_member(&mut self) -> bool {
            unreachable!()
        }

        async fn get_default_server_permissions(&mut self) -> u64 {
            unreachable!()
        }

        async fn get_our_server_role_overrides(&mut self) -> Vec<Override> {
            unreachable!()
        }

        async fn are_we_timed_out(&mut self) -> bool {
            unreachable!()
        }

        async fn do_we_have_publish_overwrites(&mut self) -> bool {
            true
        }

        async fn do_we_have_receive_overwrites(&mut self) -> bool {
            true
        }

        async fn get_channel_type(&mut self) -> ChannelType {
            ChannelType::Group
        }

        async fn get_default_channel_permissions(&mut self) -> Override {
            Override {
                allow: ChannelPermission::SendMessage as u64,
                deny: 0,
            }
        }

        async fn get_our_channel_role_overrides(&mut self) -> Vec<Override> {
            unreachable!()
        }

        async fn get_our_channel_user_override(&mut self) -> Option<Override> {
            unreachable!()
        }

        async fn do_we_own_the_channel(&mut self) -> bool {
            false
        }

        async fn are_we_part_of_the_channel(&mut self) -> bool {
            true
        }

        async fn have_voice_channel_membership(&mut self) -> bool {
            false
        }

        async fn set_recipient_as_user(&mut self) {
            unreachable!()
        }

        async fn set_server_from_channel(&mut self) {
            unreachable!()
        }
    }
}

#[async_std::test]
async fn validate_server_permissions() {
    /// Scenario in which we are in a server channel where:
    /// - the server grants reading history and sending messages by default
    /// - we have a role that allows us to upload files and react but denies reading history
    /// - however the channel disallows sending messages
    /// - and removes our role specific react permission
    struct Scenario {}
    let mut query = Scenario {};

    let perms = calculate_channel_permissions(&mut query).await;
    let value: u64 = perms.into();
    assert_eq!(
        value,
        ChannelPermission::ViewChannel as u64 | ChannelPermission::UploadFiles as u64
    );

    #[async_trait]
    impl PermissionQuery for Scenario {
        async fn are_we_a_bot(&mut self) -> bool {
            unreachable!()
        }

        async fn are_the_users_same(&mut self) -> bool {
            unreachable!()
        }

        async fn user_relationship(&mut self) -> RelationshipStatus {
            unreachable!()
        }

        async fn user_is_bot(&mut self) -> bool {
            unreachable!()
        }

        async fn have_mutual_connection(&mut self) -> bool {
            unreachable!()
        }

        async fn are_we_server_owner(&mut self) -> bool {
            false
        }

        async fn are_we_a_member(&mut self) -> bool {
            true
        }

        async fn get_default_server_permissions(&mut self) -> u64 {
            ChannelPermission::ViewChannel as u64
                | ChannelPermission::SendMessage as u64
                | ChannelPermission::ReadMessageHistory as u64
        }

        async fn get_our_server_role_overrides(&mut self) -> Vec<Override> {
            vec![Override {
                allow: ChannelPermission::UploadFiles as u64 | ChannelPermission::React as u64,
                deny: ChannelPermission::ReadMessageHistory as u64,
            }]
        }

        async fn are_we_timed_out(&mut self) -> bool {
            false
        }

        async fn do_we_have_publish_overwrites(&mut self) -> bool {
            true
        }

        async fn do_we_have_receive_overwrites(&mut self) -> bool {
            true
        }

        async fn get_channel_type(&mut self) -> ChannelType {
            ChannelType::ServerChannel
        }

        async fn get_default_channel_permissions(&mut self) -> Override {
            Override {
                allow: 0,
                deny: ChannelPermission::SendMessage as u64,
            }
        }

        async fn get_our_channel_role_overrides(&mut self) -> Vec<Override> {
            vec![Override {
                allow: 0,
                deny: ChannelPermission::React as u64,
            }]
        }

        async fn get_our_channel_user_override(&mut self) -> Option<Override> {
            None
        }

        async fn do_we_own_the_channel(&mut self) -> bool {
            unreachable!()
        }

        async fn are_we_part_of_the_channel(&mut self) -> bool {
            unreachable!()
        }

        async fn have_voice_channel_membership(&mut self) -> bool {
            false
        }

        async fn set_recipient_as_user(&mut self) {
            unreachable!()
        }

        async fn set_server_from_channel(&mut self) {
            // no-op
        }
    }
}

#[async_std::test]
async fn channel_role_override_allow_wins_over_other_role_deny() {
    /// Scenario in which two server roles conflict in one channel:
    /// Discord applies channel role denies first, then channel role allows,
    /// so the final permission must not depend on role rank/order.
    struct Scenario {}
    let mut query = Scenario {};

    let perms = calculate_channel_permissions(&mut query).await;
    assert!(perms.has_channel_permission(ChannelPermission::SendMessage));

    #[async_trait]
    impl PermissionQuery for Scenario {
        async fn are_we_a_bot(&mut self) -> bool {
            unreachable!()
        }

        async fn are_the_users_same(&mut self) -> bool {
            unreachable!()
        }

        async fn user_relationship(&mut self) -> RelationshipStatus {
            unreachable!()
        }

        async fn user_is_bot(&mut self) -> bool {
            unreachable!()
        }

        async fn have_mutual_connection(&mut self) -> bool {
            unreachable!()
        }

        async fn are_we_server_owner(&mut self) -> bool {
            false
        }

        async fn are_we_a_member(&mut self) -> bool {
            true
        }

        async fn get_default_server_permissions(&mut self) -> u64 {
            ChannelPermission::ViewChannel as u64
        }

        async fn get_our_server_role_overrides(&mut self) -> Vec<Override> {
            vec![]
        }

        async fn are_we_timed_out(&mut self) -> bool {
            false
        }

        async fn do_we_have_publish_overwrites(&mut self) -> bool {
            true
        }

        async fn do_we_have_receive_overwrites(&mut self) -> bool {
            true
        }

        async fn get_channel_type(&mut self) -> ChannelType {
            ChannelType::ServerChannel
        }

        async fn get_default_channel_permissions(&mut self) -> Override {
            Override { allow: 0, deny: 0 }
        }

        async fn get_our_channel_role_overrides(&mut self) -> Vec<Override> {
            vec![
                Override {
                    allow: ChannelPermission::SendMessage as u64,
                    deny: 0,
                },
                Override {
                    allow: 0,
                    deny: ChannelPermission::SendMessage as u64,
                },
            ]
        }

        async fn get_our_channel_user_override(&mut self) -> Option<Override> {
            None
        }

        async fn do_we_own_the_channel(&mut self) -> bool {
            unreachable!()
        }

        async fn are_we_part_of_the_channel(&mut self) -> bool {
            unreachable!()
        }

        async fn have_voice_channel_membership(&mut self) -> bool {
            false
        }

        async fn set_recipient_as_user(&mut self) {
            unreachable!()
        }

        async fn set_server_from_channel(&mut self) {
            // no-op
        }
    }
}

#[async_std::test]
async fn channel_user_override_applies_after_role_overrides() {
    /// Scenario in which a role can send messages in a channel,
    /// but the member-specific channel override denies sending.
    struct Scenario {}
    let mut query = Scenario {};

    let perms = calculate_channel_permissions(&mut query).await;
    assert!(!perms.has_channel_permission(ChannelPermission::SendMessage));

    #[async_trait]
    impl PermissionQuery for Scenario {
        async fn are_we_a_bot(&mut self) -> bool {
            unreachable!()
        }

        async fn are_the_users_same(&mut self) -> bool {
            unreachable!()
        }

        async fn user_relationship(&mut self) -> RelationshipStatus {
            unreachable!()
        }

        async fn user_is_bot(&mut self) -> bool {
            unreachable!()
        }

        async fn have_mutual_connection(&mut self) -> bool {
            unreachable!()
        }

        async fn are_we_server_owner(&mut self) -> bool {
            false
        }

        async fn are_we_a_member(&mut self) -> bool {
            true
        }

        async fn get_default_server_permissions(&mut self) -> u64 {
            ChannelPermission::ViewChannel as u64
        }

        async fn get_our_server_role_overrides(&mut self) -> Vec<Override> {
            vec![]
        }

        async fn are_we_timed_out(&mut self) -> bool {
            false
        }

        async fn do_we_have_publish_overwrites(&mut self) -> bool {
            true
        }

        async fn do_we_have_receive_overwrites(&mut self) -> bool {
            true
        }

        async fn get_channel_type(&mut self) -> ChannelType {
            ChannelType::ServerChannel
        }

        async fn get_default_channel_permissions(&mut self) -> Override {
            Override { allow: 0, deny: 0 }
        }

        async fn get_our_channel_role_overrides(&mut self) -> Vec<Override> {
            vec![Override {
                allow: ChannelPermission::SendMessage as u64,
                deny: 0,
            }]
        }

        async fn get_our_channel_user_override(&mut self) -> Option<Override> {
            Some(Override {
                allow: 0,
                deny: ChannelPermission::SendMessage as u64,
            })
        }

        async fn do_we_own_the_channel(&mut self) -> bool {
            unreachable!()
        }

        async fn are_we_part_of_the_channel(&mut self) -> bool {
            unreachable!()
        }

        async fn have_voice_channel_membership(&mut self) -> bool {
            false
        }

        async fn set_recipient_as_user(&mut self) {
            unreachable!()
        }

        async fn set_server_from_channel(&mut self) {
            // no-op
        }
    }
}

#[async_std::test]
async fn validate_timed_out_member() {
    /// Scenario in which we are in a server that we have been timed out from
    struct Scenario {}
    let mut query = Scenario {};

    let perms = calculate_channel_permissions(&mut query).await;
    let value: u64 = perms.into();
    assert_eq!(value, *DEFAULT_PERMISSION_VIEW_ONLY);

    #[async_trait]
    impl PermissionQuery for Scenario {
        async fn are_we_a_bot(&mut self) -> bool {
            unreachable!()
        }

        async fn are_the_users_same(&mut self) -> bool {
            unreachable!()
        }

        async fn user_relationship(&mut self) -> RelationshipStatus {
            unreachable!()
        }

        async fn user_is_bot(&mut self) -> bool {
            unreachable!()
        }

        async fn have_mutual_connection(&mut self) -> bool {
            unreachable!()
        }

        async fn are_we_server_owner(&mut self) -> bool {
            false
        }

        async fn are_we_a_member(&mut self) -> bool {
            true
        }

        async fn get_default_server_permissions(&mut self) -> u64 {
            *DEFAULT_PERMISSION_SERVER
        }

        async fn get_our_server_role_overrides(&mut self) -> Vec<Override> {
            vec![]
        }

        async fn are_we_timed_out(&mut self) -> bool {
            true
        }

        async fn do_we_have_publish_overwrites(&mut self) -> bool {
            true
        }

        async fn do_we_have_receive_overwrites(&mut self) -> bool {
            true
        }

        async fn get_channel_type(&mut self) -> ChannelType {
            ChannelType::ServerChannel
        }

        async fn get_default_channel_permissions(&mut self) -> Override {
            Override { allow: 0, deny: 0 }
        }

        async fn get_our_channel_role_overrides(&mut self) -> Vec<Override> {
            vec![]
        }

        async fn get_our_channel_user_override(&mut self) -> Option<Override> {
            None
        }

        async fn do_we_own_the_channel(&mut self) -> bool {
            unreachable!()
        }

        async fn are_we_part_of_the_channel(&mut self) -> bool {
            unreachable!()
        }

        async fn have_voice_channel_membership(&mut self) -> bool {
            false
        }

        async fn set_recipient_as_user(&mut self) {
            unreachable!()
        }

        async fn set_server_from_channel(&mut self) {
            // no-op
        }
    }
}

#[async_std::test]
async fn access_admin_does_not_get_user_permissions_automatically() {
    let mut query = AccessAdminWithoutMembership {
        _has_access_admin: true,
    };

    assert_eq!(u64::from(calculate_user_permissions(&mut query).await), 0);
}

#[async_std::test]
async fn access_admin_without_membership_gets_no_server_or_channel_permissions() {
    let mut query = AccessAdminWithoutMembership {
        _has_access_admin: true,
    };

    assert_eq!(u64::from(calculate_server_permissions(&mut query).await), 0);
    assert_eq!(
        u64::from(calculate_channel_permissions(&mut query).await),
        0
    );
}

// The production query may still carry this account-level flag, but AccessAdmin is
// deliberately absent from PermissionQuery because it only authorizes admin routes.
struct AccessAdminWithoutMembership {
    _has_access_admin: bool,
}

#[async_trait]
impl PermissionQuery for AccessAdminWithoutMembership {
    async fn are_we_a_bot(&mut self) -> bool {
        false
    }

    async fn are_the_users_same(&mut self) -> bool {
        false
    }

    async fn user_relationship(&mut self) -> RelationshipStatus {
        RelationshipStatus::None
    }

    async fn user_is_bot(&mut self) -> bool {
        false
    }

    async fn have_mutual_connection(&mut self) -> bool {
        false
    }

    async fn are_we_server_owner(&mut self) -> bool {
        false
    }

    async fn are_we_a_member(&mut self) -> bool {
        false
    }

    async fn get_default_server_permissions(&mut self) -> u64 {
        unreachable!()
    }

    async fn get_our_server_role_overrides(&mut self) -> Vec<Override> {
        unreachable!()
    }

    async fn are_we_timed_out(&mut self) -> bool {
        unreachable!()
    }

    async fn do_we_have_publish_overwrites(&mut self) -> bool {
        unreachable!()
    }

    async fn do_we_have_receive_overwrites(&mut self) -> bool {
        unreachable!()
    }

    async fn get_channel_type(&mut self) -> ChannelType {
        ChannelType::ServerChannel
    }

    async fn get_default_channel_permissions(&mut self) -> Override {
        unreachable!()
    }

    async fn get_our_channel_role_overrides(&mut self) -> Vec<Override> {
        unreachable!()
    }

    async fn get_our_channel_user_override(&mut self) -> Option<Override> {
        unreachable!()
    }

    async fn do_we_own_the_channel(&mut self) -> bool {
        unreachable!()
    }

    async fn are_we_part_of_the_channel(&mut self) -> bool {
        unreachable!()
    }

    async fn have_voice_channel_membership(&mut self) -> bool {
        false
    }

    async fn set_recipient_as_user(&mut self) {
        unreachable!()
    }

    async fn set_server_from_channel(&mut self) {
        // no-op
    }
}

struct ServerChannelAccessScenario {
    server_permissions: u64,
    role_permissions: Override,
    channel_permissions: Override,
    voice_membership: bool,
}

#[async_trait]
impl PermissionQuery for ServerChannelAccessScenario {
    async fn are_we_a_bot(&mut self) -> bool {
        false
    }

    async fn are_the_users_same(&mut self) -> bool {
        false
    }

    async fn user_relationship(&mut self) -> RelationshipStatus {
        RelationshipStatus::None
    }

    async fn user_is_bot(&mut self) -> bool {
        false
    }

    async fn have_mutual_connection(&mut self) -> bool {
        false
    }

    async fn are_we_server_owner(&mut self) -> bool {
        false
    }

    async fn are_we_a_member(&mut self) -> bool {
        true
    }

    async fn get_default_server_permissions(&mut self) -> u64 {
        self.server_permissions
    }

    async fn get_our_server_role_overrides(&mut self) -> Vec<Override> {
        vec![self.role_permissions.clone()]
    }

    async fn are_we_timed_out(&mut self) -> bool {
        false
    }

    async fn do_we_have_publish_overwrites(&mut self) -> bool {
        true
    }

    async fn do_we_have_receive_overwrites(&mut self) -> bool {
        true
    }

    async fn get_channel_type(&mut self) -> ChannelType {
        ChannelType::ServerChannel
    }

    async fn get_default_channel_permissions(&mut self) -> Override {
        self.channel_permissions.clone()
    }

    async fn get_our_channel_role_overrides(&mut self) -> Vec<Override> {
        vec![]
    }

    async fn get_our_channel_user_override(&mut self) -> Option<Override> {
        None
    }

    async fn do_we_own_the_channel(&mut self) -> bool {
        false
    }

    async fn are_we_part_of_the_channel(&mut self) -> bool {
        false
    }

    async fn have_voice_channel_membership(&mut self) -> bool {
        self.voice_membership
    }

    async fn set_recipient_as_user(&mut self) {
        unreachable!()
    }

    async fn set_server_from_channel(&mut self) {}
}

#[async_std::test]
async fn administrator_grants_all_regular_permissions_and_bypasses_channel_denies() {
    let mut query = ServerChannelAccessScenario {
        server_permissions: 0,
        role_permissions: Override {
            allow: ChannelPermission::Administrator as u64,
            deny: 0,
        },
        channel_permissions: Override {
            allow: 0,
            deny: ChannelPermission::GrantAllSafe as u64,
        },
        voice_membership: false,
    };

    assert_eq!(
        u64::from(calculate_server_permissions(&mut query).await),
        ChannelPermission::GrantAllSafe as u64
    );
    assert_eq!(
        u64::from(calculate_channel_permissions(&mut query).await),
        ChannelPermission::GrantAllSafe as u64
    );
}

#[async_std::test]
async fn active_voice_membership_only_bypasses_view_and_connect_denies() {
    let mut query = ServerChannelAccessScenario {
        server_permissions: ChannelPermission::Speak as u64 | ChannelPermission::Listen as u64,
        role_permissions: Override::default(),
        channel_permissions: Override {
            allow: 0,
            deny: ChannelPermission::ViewChannel as u64
                | ChannelPermission::Connect as u64
                | ChannelPermission::Listen as u64,
        },
        voice_membership: true,
    };

    let permissions = calculate_channel_permissions(&mut query).await;
    assert!(permissions.has_channel_permission(ChannelPermission::ViewChannel));
    assert!(permissions.has_channel_permission(ChannelPermission::Connect));
    assert!(permissions.has_channel_permission(ChannelPermission::Speak));
    assert!(!permissions.has_channel_permission(ChannelPermission::Listen));
}
