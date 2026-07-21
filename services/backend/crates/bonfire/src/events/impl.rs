use std::collections::{HashMap, HashSet};

use futures::future::join_all;
use syrnike_database::{
    events::client::{
        AuthorizationSnapshot, EventV1, ReadyPayloadFields, VoiceCall, VoiceCallPhase,
    },
    util::permissions::DatabasePermissionQuery,
    voice::{
        call_lifecycle::{get_channel_voice_call, VoiceCallPhase as StoredVoiceCallPhase},
        get_channel_voice_state, UserVoiceChannel,
    },
    Channel, Database, Member, Presence, RelationshipStatus, Role,
};
use syrnike_models::v0;
use syrnike_permissions::{
    calculate_channel_permissions, calculate_server_permissions, calculate_user_permissions,
    ChannelPermission, GlobalPermission,
};
use syrnike_presence::filter_online;
use syrnike_result::Result;

use super::state::{Cache, State};

/// Cache Manager
impl Cache {
    /// Check whether the current user can view a channel
    pub async fn can_view_channel(&self, db: &Database, channel: &Channel) -> bool {
        self.can_view_channel_inner(db, channel, false).await
    }

    /// Evaluate the destination using a trusted voice authority move as proof
    /// of temporary voice membership. The durable session projection can lag
    /// a few moments behind the authority event.
    async fn can_view_voice_move_destination(&self, db: &Database, channel: &Channel) -> bool {
        self.can_view_channel_inner(db, channel, true).await
    }

    async fn can_view_channel_inner(
        &self,
        db: &Database,
        channel: &Channel,
        forced_voice_membership: bool,
    ) -> bool {
        #[allow(deprecated)]
        match &channel {
            Channel::TextChannel { server, .. } => {
                let member = self.current_membership(server);
                let server = self.servers.get(server);
                let mut query =
                    DatabasePermissionQuery::new(db, self.users.get(&self.user_id).unwrap())
                        .channel(channel);
                // let mut perms = perms(self.users.get(&self.user_id).unwrap()).channel(channel);

                if let Some(member) = member {
                    query = query.member(member);
                }

                if let Some(server) = server {
                    query = query.server(server);
                }

                if forced_voice_membership {
                    query = query.voice_channel_membership();
                }

                calculate_channel_permissions(&mut query)
                    .await
                    .has_channel_permission(ChannelPermission::ViewChannel)
            }
            _ => true,
        }
    }

    /// Filter a given vector of channels to only include the ones we can access
    pub async fn filter_accessible_channels(
        &self,
        db: &Database,
        channels: Vec<Channel>,
    ) -> Vec<Channel> {
        let mut viewable_channels = vec![];
        for channel in channels {
            if self.can_view_channel(db, &channel).await {
                viewable_channels.push(channel);
            }
        }

        viewable_channels
    }

    /// Check whether we can subscribe to another user
    pub fn can_subscribe_to_user(&self, user_id: &str) -> bool {
        if let Some(user) = self.users.get(&self.user_id) {
            match user.relationship_with(user_id) {
                RelationshipStatus::Friend
                | RelationshipStatus::Incoming
                | RelationshipStatus::Outgoing
                | RelationshipStatus::User => true,
                _ => {
                    let user_id = &user_id.to_string();
                    for channel in self.channels.values() {
                        match channel {
                            Channel::DirectMessage { recipients, .. }
                            | Channel::Group { recipients, .. } => {
                                if recipients.contains(user_id) {
                                    return true;
                                }
                            }
                            _ => {}
                        }
                    }

                    false
                }
            }
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use syrnike_database::{DatabaseInfo, MemberCompositeKey, PartialRole, Role, Server, User};
    use syrnike_permissions::OverrideField;

    use super::*;

    #[async_std::test]
    async fn server_create_rejects_membership_for_another_user() {
        let db = DatabaseInfo::Reference
            .connect()
            .await
            .expect("reference database");
        let server_id = "server-1".to_string();
        let mut state = State::from(
            User {
                id: "current-user".to_string(),
                username: "current".to_string(),
                discriminator: "0001".to_string(),
                ..Default::default()
            },
            "session-1".to_string(),
        );
        let mut event = EventV1::ServerCreate {
            id: server_id.clone(),
            server: Server {
                id: server_id.clone(),
                owner: "owner-1".to_string(),
                name: "Server".to_string(),
                description: None,
                channels: vec![],
                categories: None,
                system_messages: None,
                roles: HashMap::new(),
                default_permissions: 0,
                icon: None,
                banner: None,
                flags: None,
                nsfw: false,
                analytics: false,
                discoverable: false,
            }
            .into(),
            channels: vec![],
            member: Member {
                id: MemberCompositeKey {
                    server: server_id.clone(),
                    user: "another-user".to_string(),
                },
                ..Default::default()
            }
            .into(),
            emojis: vec![],
            voice_states: vec![],
        };

        assert!(!state.handle_incoming_event_v1(&db, &mut event).await);
        assert!(!state.subscribed.read().await.contains(&server_id));
        assert!(!state.cache.servers.contains_key(&server_id));
        assert!(state.cache.current_membership(&server_id).is_none());
    }

    #[async_std::test]
    async fn server_role_update_inserts_missing_created_role_in_cache() {
        let db = DatabaseInfo::Reference
            .connect()
            .await
            .expect("reference database");
        let user = User {
            id: "user-1".to_string(),
            username: "user".to_string(),
            discriminator: "0001".to_string(),
            ..Default::default()
        };
        let server_id = "server-1".to_string();
        let role_id = "role-new".to_string();

        let mut state = State::from(user, "session-1".to_string());
        state.cache.servers.insert(
            server_id.clone(),
            Server {
                id: server_id.clone(),
                owner: "owner-1".to_string(),
                name: "Server".to_string(),
                description: None,
                channels: vec![],
                categories: None,
                system_messages: None,
                roles: HashMap::new(),
                default_permissions: 0,
                icon: None,
                banner: None,
                flags: None,
                nsfw: false,
                analytics: false,
                discoverable: false,
            },
        );
        state.insert_subscription(server_id.clone()).await;
        state.apply_state().await;
        state.authorization_enabled = true;

        let mut event = EventV1::ServerRoleUpdate {
            id: server_id.clone(),
            role_id: role_id.clone(),
            data: PartialRole {
                id: Some(role_id.clone()),
                name: Some("Moderators".to_string()),
                permissions: Some(OverrideField::default()),
                colour: None,
                hoist: Some(false),
                mentionable: Some(true),
                rank: Some(0),
                icon: None,
            }
            .into(),
            clear: vec![],
        };

        assert!(state.handle_incoming_event_v1(&db, &mut event).await);

        let role = state
            .cache
            .servers
            .get(&server_id)
            .and_then(|server| server.roles.get(&role_id))
            .expect("role inserted");
        assert_eq!(role.name, "Moderators");
        assert_eq!(role.id, role_id);
        assert!(matches!(
            event,
            EventV1::Bulk { ref v }
                if v.iter().any(|event| matches!(
                    event,
                    EventV1::AuthorizationSnapshot { snapshot }
                        if snapshot.revision == 1 && snapshot.servers.contains_key(&server_id)
                ))
        ));
    }

    #[async_std::test]
    async fn channel_create_for_hidden_server_channel_is_not_cached_or_forwarded() {
        let db = DatabaseInfo::Reference
            .connect()
            .await
            .expect("reference database");
        let user = User {
            id: "user-1".to_string(),
            username: "user".to_string(),
            discriminator: "0001".to_string(),
            ..Default::default()
        };
        let server_id = "server-1".to_string();
        let channel_id = "channel-hidden".to_string();

        let mut state = State::from(user.clone(), "session-1".to_string());
        state.cache.servers.insert(
            server_id.clone(),
            Server {
                id: server_id.clone(),
                owner: "owner-1".to_string(),
                name: "Server".to_string(),
                description: None,
                channels: vec![channel_id.clone()],
                categories: None,
                system_messages: None,
                roles: HashMap::new(),
                default_permissions: 0,
                icon: None,
                banner: None,
                flags: None,
                nsfw: false,
                analytics: false,
                discoverable: false,
            },
        );
        state.cache.upsert_current_membership(Member {
            id: MemberCompositeKey {
                server: server_id.clone(),
                user: user.id.clone(),
            },
            roles: vec![],
            ..Default::default()
        });
        state.insert_subscription(server_id.clone()).await;
        state.apply_state().await;

        let mut event = EventV1::ChannelCreate(
            Channel::TextChannel {
                id: channel_id.clone(),
                server: server_id,
                name: "hidden".to_string(),
                description: None,
                icon: None,
                last_message_id: None,
                default_permissions: None,
                role_permissions: HashMap::new(),
                user_permissions: HashMap::new(),
                nsfw: false,
                voice: None,
                slowmode: None,
            }
            .into(),
        );

        assert!(!state.handle_incoming_event_v1(&db, &mut event).await);
        assert!(!state.subscribed.read().await.contains(&channel_id));
        assert!(!state.cache.channels.contains_key(&channel_id));
    }

    #[async_std::test]
    async fn server_role_ranks_update_keeps_combined_channel_overrides_visible() {
        let db = DatabaseInfo::Reference
            .connect()
            .await
            .expect("reference database");
        let user = User {
            id: "user-1".to_string(),
            username: "user".to_string(),
            discriminator: "0001".to_string(),
            ..Default::default()
        };
        let server_id = "server-1".to_string();
        let channel_id = "channel-1".to_string();
        let allow_role_id = "role-allow".to_string();
        let deny_role_id = "role-deny".to_string();
        let view_channel = ChannelPermission::ViewChannel as i64;

        let mut state = State::from(user.clone(), "session-1".to_string());
        let server = Server {
            id: server_id.clone(),
            owner: "owner-1".to_string(),
            name: "Server".to_string(),
            description: None,
            channels: vec![channel_id.clone()],
            categories: None,
            system_messages: None,
            roles: HashMap::from([
                (
                    allow_role_id.clone(),
                    Role {
                        id: allow_role_id.clone(),
                        name: "Allow".to_string(),
                        permissions: OverrideField::default(),
                        colour: None,
                        hoist: false,
                        mentionable: true,
                        rank: 0,
                        icon: None,
                    },
                ),
                (
                    deny_role_id.clone(),
                    Role {
                        id: deny_role_id.clone(),
                        name: "Deny".to_string(),
                        permissions: OverrideField::default(),
                        colour: None,
                        hoist: false,
                        mentionable: true,
                        rank: 1,
                        icon: None,
                    },
                ),
            ]),
            default_permissions: 0,
            icon: None,
            banner: None,
            flags: None,
            nsfw: false,
            analytics: false,
            discoverable: false,
        };
        let member = Member {
            id: MemberCompositeKey {
                server: server_id.clone(),
                user: user.id.clone(),
            },
            roles: vec![allow_role_id.clone(), deny_role_id.clone()],
            ..Default::default()
        };
        let channel = Channel::TextChannel {
            id: channel_id.clone(),
            server: server_id.clone(),
            name: "hidden".to_string(),
            description: None,
            icon: None,
            last_message_id: None,
            default_permissions: Some(OverrideField {
                a: 0,
                d: view_channel,
            }),
            role_permissions: HashMap::from([
                (
                    allow_role_id.clone(),
                    OverrideField {
                        a: view_channel,
                        d: 0,
                    },
                ),
                (
                    deny_role_id.clone(),
                    OverrideField {
                        a: 0,
                        d: view_channel,
                    },
                ),
            ]),
            user_permissions: HashMap::new(),
            nsfw: false,
            voice: None,
            slowmode: None,
        };

        state.cache.servers.insert(server_id.clone(), server);
        state.cache.upsert_current_membership(member);
        state.cache.channels.insert(channel_id.clone(), channel);
        state.insert_subscription(server_id.clone()).await;
        state.insert_subscription(channel_id.clone()).await;
        state.apply_state().await;

        let mut event = EventV1::ServerRoleRanksUpdate {
            id: server_id.clone(),
            ranks: vec![deny_role_id, allow_role_id],
        };

        assert!(state.handle_incoming_event_v1(&db, &mut event).await);
        assert!(matches!(
            event,
            EventV1::ServerRoleRanksUpdate { ref id, .. } if id == &server_id
        ));
        assert!(state.subscribed.read().await.contains(&channel_id));
        assert!(state.cache.channels.contains_key(&channel_id));
    }
}

/// State Manager
impl State {
    async fn authorization_snapshot(&self, db: &Database, revision: u64) -> AuthorizationSnapshot {
        let perspective = self
            .cache
            .users
            .get(&self.cache.user_id)
            .expect("authorization perspective missing from gateway cache");

        let mut servers = HashMap::new();
        for (server_id, server) in &self.cache.servers {
            let mut query = DatabasePermissionQuery::new(db, perspective).server(server);
            if let Some(member) = self.cache.current_membership(server_id) {
                query = query.member(member);
            }
            servers.insert(
                server_id.clone(),
                calculate_server_permissions(&mut query).await.into_raw(),
            );
        }

        let mut channels = HashMap::new();
        for (channel_id, channel) in &self.cache.channels {
            let mut query = DatabasePermissionQuery::new(db, perspective).channel(channel);
            if let Some(server_id) = channel.server() {
                if let Some(server) = self.cache.servers.get(server_id) {
                    query = query.server(server);
                }
                if let Some(member) = self.cache.current_membership(server_id) {
                    query = query.member(member);
                }
            }
            channels.insert(
                channel_id.clone(),
                calculate_channel_permissions(&mut query).await.into_raw(),
            );
        }

        let mut users = HashMap::new();
        for (user_id, user) in &self.cache.users {
            let mut query = DatabasePermissionQuery::new(db, perspective).user(user);
            users.insert(
                user_id.clone(),
                calculate_user_permissions(&mut query).await.into_raw(),
            );
        }

        AuthorizationSnapshot {
            revision,
            global: if perspective.privileged {
                GlobalPermission::AccessAdmin as u64
            } else {
                0
            },
            servers,
            channels,
            users,
        }
    }

    async fn next_authorization_snapshot(&mut self, db: &Database) -> AuthorizationSnapshot {
        self.authorization_revision = self.authorization_revision.saturating_add(1);
        self.authorization_snapshot(db, self.authorization_revision)
            .await
    }

    /// Generate a Ready packet for the current user
    pub async fn generate_ready_payload(
        &mut self,
        db: &Database,
        fields: &ReadyPayloadFields,
    ) -> Result<EventV1> {
        self.authorization_enabled = fields.authorization;
        let user = self.clone_user();
        self.cache.is_bot = user.bot.is_some();

        // Fetch pending policy changes.
        let policy_changes = if user.bot.is_some() || !fields.policy_changes {
            None
        } else {
            Some(
                db.fetch_policy_changes()
                    .await?
                    .into_iter()
                    .filter(|policy| policy.created_time > user.last_acknowledged_policy_change)
                    .map(Into::into)
                    .collect(),
            )
        };

        // Find all relationships to the user.
        let mut user_ids: HashSet<String> = user
            .relations
            .as_ref()
            .map(|arr| arr.iter().map(|x| x.id.to_string()).collect())
            .unwrap_or_default();

        // Fetch all memberships with their corresponding servers.
        let current_memberships: Vec<Member> = db
            .fetch_all_memberships(&user.id)
            .await?
            .into_iter()
            .filter(|membership| membership.id.user == user.id)
            .collect();
        let server_ids: Vec<String> = current_memberships
            .iter()
            .map(|membership| membership.id.server.clone())
            .collect();
        self.cache
            .replace_current_memberships(current_memberships.iter().cloned());
        let mut ready_members: HashMap<_, _> = current_memberships
            .into_iter()
            .map(|membership| (membership.id.clone(), membership))
            .collect();

        let servers = db.fetch_servers(&server_ids).await?;
        self.cache.servers = servers.iter().cloned().map(|x| (x.id.clone(), x)).collect();

        // Collect channel ids from servers.
        let mut channel_ids = vec![];
        for server in &servers {
            channel_ids.append(&mut server.channels.clone());
        }

        // Fetch DMs and server channels.
        let mut channels = Vec::new();
        for channel in db.find_direct_messages(&user.id).await? {
            if !channel.has_bot_recipient(db).await? {
                channels.push(channel);
            }
        }
        channels.append(&mut db.fetch_channels(&channel_ids).await?);

        // Filter server channels by permission.
        let channels = self.cache.filter_accessible_channels(db, channels).await;

        // Append known user IDs from DMs.
        for channel in &channels {
            match channel {
                Channel::DirectMessage { recipients, .. } | Channel::Group { recipients, .. } => {
                    user_ids.extend(&mut recipients.clone().into_iter());
                }
                _ => {}
            }
        }

        let voice_states = if fields.voice_states {
            let mut voice_state_server_members: HashMap<String, HashSet<String>> = HashMap::new();

            // fetch voice states for all the channels we can see
            let mut voice_states = Vec::new();

            for channel in channels.iter().filter(|c| {
                matches!(
                    c,
                    Channel::DirectMessage { .. }
                        | Channel::Group { .. }
                        | Channel::TextChannel { voice: Some(_), .. }
                )
            }) {
                if let Ok(Some(voice_state)) =
                    get_channel_voice_state(&UserVoiceChannel::from_channel(channel)).await
                {
                    if let Some(server) = channel.server() {
                        let set = voice_state_server_members
                            .entry(server.to_string())
                            .or_default();

                        for participant in &voice_state.participants {
                            user_ids.insert(participant.id.clone());
                            set.insert(participant.id.clone());
                        }
                    } else {
                        for participant in &voice_state.participants {
                            user_ids.insert(participant.id.clone());
                        }
                    }

                    voice_states.push(voice_state);
                }
            }

            // Fetch all the members for for the participants who are in a server
            for (server, user_ids) in voice_state_server_members {
                let user_ids = user_ids.into_iter().collect::<Vec<_>>();
                let voice_members = db.fetch_members(&server, &user_ids).await?;

                for member in voice_members {
                    // Keep the current user's membership from the authorization fetch above so
                    // Ready.members and the initial authorization snapshot share one source.
                    ready_members.entry(member.id.clone()).or_insert(member);
                }
            }

            Some(voice_states)
        } else {
            None
        };

        let voice_calls = if fields.voice_calls {
            let mut voice_calls = Vec::new();

            for channel in channels.iter().filter(|channel| {
                matches!(
                    channel,
                    Channel::DirectMessage { .. } | Channel::Group { .. }
                )
            }) {
                if let Some(call) = get_channel_voice_call(channel.id()).await? {
                    user_ids.insert(call.initiator_id.clone());
                    user_ids.extend(call.ringing_recipients.iter().cloned());
                    user_ids.extend(call.declined_recipients.iter().cloned());

                    voice_calls.push(VoiceCall {
                        channel_id: call.channel_id,
                        initiator_id: call.initiator_id,
                        phase: match call.phase {
                            StoredVoiceCallPhase::Ringing => VoiceCallPhase::Ringing,
                            StoredVoiceCallPhase::Active => VoiceCallPhase::Active,
                        },
                        started_at: call.started_at,
                        expires_at: call.expires_at,
                        recipients: call.ringing_recipients,
                        declined_recipients: call.declined_recipients,
                    });
                }
            }

            Some(voice_calls)
        } else {
            None
        };

        // Fetch presence data for known users.
        let online_ids = filter_online(&user_ids.iter().cloned().collect::<Vec<String>>()).await;

        // Fetch user data.
        let users = db
            .fetch_users(
                &user_ids
                    .into_iter()
                    .filter(|x| x != &user.id)
                    .collect::<Vec<String>>(),
            )
            .await?;

        // Fetch customisations.
        let emojis = if fields.emojis {
            Some(
                db.fetch_emoji_by_parent_ids(
                    &servers
                        .iter()
                        .map(|x| x.id.to_string())
                        .collect::<Vec<String>>(),
                )
                .await?
                .into_iter()
                .map(|emoji| emoji.into())
                .collect(),
            )
        } else {
            None
        };

        // Fetch user settings
        let user_settings = if !fields.user_settings.is_empty() {
            Some(
                db.fetch_user_settings(&user.id, &fields.user_settings)
                    .await?,
            )
        } else {
            None
        };

        // Fetch channel unreads
        let channel_unreads = if fields.channel_unreads {
            Some(
                db.fetch_unreads(&user.id)
                    .await?
                    .into_iter()
                    .map(|unread| unread.into())
                    .collect(),
            )
        } else {
            None
        };

        // Copy data into local state cache.
        self.cache.users = users.iter().cloned().map(|x| (x.id.clone(), x)).collect();
        self.cache
            .users
            .insert(self.cache.user_id.clone(), user.clone());
        self.cache.channels = channels
            .iter()
            .cloned()
            .map(|x| (x.id().to_string(), x))
            .collect();

        // Make all users appear from our perspective.
        let mut users: Vec<v0::User> = join_all(users.into_iter().map(|other_user| async {
            let is_online = online_ids.contains(&other_user.id);
            other_user.into_known(&user, is_online).await
        }))
        .await;

        // Make sure we see our own user correctly.
        users.push(user.into_self(true).await);

        // Set subscription state internally.
        self.reset_state().await;
        self.insert_subscription(self.private_topic.clone()).await;

        for user in &users {
            self.insert_subscription(user.id.clone()).await;
        }

        for server in &servers {
            self.insert_subscription(server.id.clone()).await;

            if self.cache.is_bot {
                self.insert_subscription(format!("{}u", server.id)).await;
            }
        }

        for channel in &channels {
            self.insert_subscription(channel.id().to_string()).await;
        }

        let authorization = if fields.authorization {
            Some(self.next_authorization_snapshot(db).await)
        } else {
            None
        };

        Ok(EventV1::Ready {
            users: if fields.users { Some(users) } else { None },
            servers: if fields.servers {
                Some(servers.into_iter().map(Into::into).collect())
            } else {
                None
            },
            channels: if fields.channels {
                Some(channels.into_iter().map(Into::into).collect())
            } else {
                None
            },
            members: if fields.members {
                Some(ready_members.into_values().map(Into::into).collect())
            } else {
                None
            },
            voice_states,
            voice_calls,

            emojis,
            user_settings,
            channel_unreads,

            policy_changes,
            authorization,
        })
    }

    /// Re-determine the currently accessible server channels
    pub async fn recalculate_server(&mut self, db: &Database, id: &str, event: &mut EventV1) {
        if let Some(server) = self.cache.servers.get(id) {
            let mut channel_ids = HashSet::new();
            let mut added_channels = vec![];
            let mut removed_channels = vec![];

            let id = &id.to_string();
            for (channel_id, channel) in &self.cache.channels {
                if channel.server() == Some(id) {
                    channel_ids.insert(channel_id.clone());

                    if self.cache.can_view_channel(db, channel).await {
                        added_channels.push(channel_id.clone());
                    } else {
                        removed_channels.push(channel_id.clone());
                    }
                }
            }

            let known_ids = server.channels.iter().cloned().collect::<HashSet<String>>();

            let mut bulk_events = vec![];

            for id in added_channels {
                self.insert_subscription(id).await;
            }

            for id in removed_channels {
                self.remove_subscription(&id).await;
                self.cache.channels.remove(&id);

                bulk_events.push(EventV1::ChannelDelete { id });
            }

            // * NOTE: currently all channels should be cached
            // * provided that a server was loaded from payload
            let unknowns = known_ids
                .difference(&channel_ids)
                .cloned()
                .collect::<Vec<String>>();

            if !unknowns.is_empty() {
                if let Ok(channels) = db.fetch_channels(&unknowns).await {
                    let viewable_channels =
                        self.cache.filter_accessible_channels(db, channels).await;

                    for channel in viewable_channels {
                        self.cache
                            .channels
                            .insert(channel.id().to_string(), channel.clone());

                        self.insert_subscription(channel.id().to_string()).await;
                        bulk_events.push(EventV1::ChannelCreate(channel.into()));
                    }
                }
            }

            if !bulk_events.is_empty() {
                let mut new_event = EventV1::Bulk { v: bulk_events };
                std::mem::swap(&mut new_event, event);

                if let EventV1::Bulk { v } = event {
                    v.push(new_event);
                }
            }
        }
    }

    /// Push presence change to the user and all associated server topics
    pub async fn broadcast_presence_change(&self, target: bool) {
        let config = syrnike_config::config().await;
        if config.disable_events_dont_use {
            return;
        }

        if if let Some(status) = &self.cache.users.get(&self.cache.user_id).unwrap().status {
            status.presence != Some(Presence::Invisible)
        } else {
            true
        } {
            let event = EventV1::UserUpdate {
                id: self.cache.user_id.clone(),
                data: v0::PartialUser {
                    online: Some(target),
                    ..Default::default()
                },
                clear: vec![],
                event_id: Some(ulid::Ulid::new().to_string()),
            };

            for server in self.cache.servers.keys() {
                event.clone().p(server.clone()).await;
            }

            event.p(self.cache.user_id.clone()).await;
        }
    }

    /// Handle an incoming event for protocol version 1
    pub async fn handle_incoming_event_v1(&mut self, db: &Database, event: &mut EventV1) -> bool {
        /* Superseded by private topics.
          if match event {
            EventV1::UserRelationship { id, .. }
            | EventV1::UserSettingsUpdate { id, .. }
            | EventV1::ChannelAck { id, .. } => id != &self.cache.user_id,
            EventV1::ServerCreate { server, .. } => server.owner != self.cache.user_id,
            EventV1::ChannelCreate(channel) => match channel {
                Channel::SavedMessages { user, .. } => user != &self.cache.user_id,
                Channel::DirectMessage { recipients, .. } | Channel::Group { recipients, .. } => {
                    !recipients.contains(&self.cache.user_id)
                }
                _ => false,
            },
            _ => false,
        } {
            return false;
        }*/

        // An event may trigger recalculation of an entire server's permission.
        // Keep track of whether we need to do anything.
        let mut queue_server = None;

        // It may also need to sub or unsub a single value.
        let mut queue_add = None;
        let mut queue_remove = None;
        let mut refresh_authorization = false;

        match event {
            EventV1::ChannelCreate(channel) => {
                let id = channel.id().to_string();
                let channel = channel.clone().into();
                if !self.cache.can_view_channel(db, &channel).await {
                    return false;
                }

                self.insert_subscription(id.clone()).await;
                self.cache.channels.insert(id, channel);
                refresh_authorization = true;
            }
            EventV1::ChannelUpdate {
                id, data, clear, ..
            } => {
                let could_view: bool = if let Some(channel) = self.cache.channels.get(id) {
                    self.cache.can_view_channel(db, channel).await
                } else {
                    false
                };

                if let Some(channel) = self.cache.channels.get_mut(id) {
                    for field in clear {
                        channel.remove_field(&field.clone().into());
                    }

                    channel.apply_options(data.clone().into());
                }

                if !self.cache.channels.contains_key(id) {
                    if let Ok(channel) = db.fetch_channel(id).await {
                        self.cache.channels.insert(id.clone(), channel);
                    }
                }

                if let Some(channel) = self.cache.channels.get(id) {
                    let can_view = self.cache.can_view_channel(db, channel).await;
                    if !can_view {
                        // A stale client may still hold this channel even when
                        // this gateway cache already considered it hidden.
                        // Always make the post-update visibility authoritative.
                        queue_remove = Some(id.clone());
                        *event = EventV1::ChannelDelete { id: id.clone() };
                    } else if !could_view {
                        queue_add = Some(id.clone());
                        *event = EventV1::ChannelCreate(channel.clone().into());
                    }
                }
                refresh_authorization = true;
            }
            EventV1::ChannelDelete { id } => {
                self.remove_subscription(id).await;
                self.cache.channels.remove(id);
                refresh_authorization = true;
            }
            EventV1::ChannelGroupJoin { user, .. } => {
                self.insert_subscription(user.clone()).await;
                refresh_authorization = true;
            }
            EventV1::ChannelGroupLeave { id, user, .. } => {
                if user == &self.cache.user_id {
                    self.remove_subscription(id).await;
                } else if !self.cache.can_subscribe_to_user(user) {
                    self.remove_subscription(user).await;
                }
                refresh_authorization = true;
            }

            EventV1::ServerCreate {
                id,
                server,
                channels,
                member,
                emojis: _,
                voice_states: _,
            } => {
                if member.id.user != self.cache.user_id || member.id.server != id.as_str() {
                    return false;
                }

                self.insert_subscription(id.clone()).await;

                if self.cache.is_bot {
                    self.insert_subscription(format!("{}u", id)).await;
                }

                self.cache.servers.insert(id.clone(), server.clone().into());
                self.cache.upsert_current_membership(member.clone().into());

                for channel in channels {
                    self.cache
                        .channels
                        .insert(channel.id().to_string(), channel.clone().into());
                }

                queue_server = Some(id.clone());
                refresh_authorization = true;
            }
            EventV1::ServerUpdate {
                id, data, clear, ..
            } => {
                if let Some(server) = self.cache.servers.get_mut(id) {
                    for field in clear {
                        server.remove_field(&field.clone().into());
                    }

                    server.apply_options(data.clone().into());
                }

                if data.default_permissions.is_some() {
                    queue_server = Some(id.clone());
                }
                refresh_authorization = true;
            }
            EventV1::ServerMemberJoin { .. } => {
                // We will always receive ServerCreate when joining a new server.
            }
            EventV1::ServerMemberLeave { id, user, .. } => {
                if user == &self.cache.user_id {
                    self.remove_subscription(id).await;

                    if let Some(server) = self.cache.servers.remove(id) {
                        for channel in &server.channels {
                            self.remove_subscription(channel).await;
                            self.cache.channels.remove(channel);
                        }
                    }
                    self.cache.remove_current_membership(id);
                    refresh_authorization = true;
                }
            }
            EventV1::ServerDelete { id } => {
                self.remove_subscription(id).await;

                if let Some(server) = self.cache.servers.remove(id) {
                    for channel in &server.channels {
                        self.remove_subscription(channel).await;
                        self.cache.channels.remove(channel);
                    }
                }
                self.cache.remove_current_membership(id);
                refresh_authorization = true;
            }
            EventV1::ServerMemberUpdate { id, data, clear } => {
                if id.user == self.cache.user_id {
                    if let Some(member) = self.cache.current_membership_mut(&id.server) {
                        for field in &clear.clone() {
                            member.remove_field(&field.clone().into());
                        }

                        member.apply_options(data.clone().into());
                    }

                    if data.roles.is_some() || clear.contains(&v0::FieldsMember::Roles) {
                        queue_server = Some(id.server.clone());
                    }
                    refresh_authorization = true;
                }
            }
            EventV1::ServerRoleUpdate {
                id,
                role_id,
                data,
                clear,
                ..
            } => {
                if let Some(server) = self.cache.servers.get_mut(id) {
                    let partial: syrnike_database::PartialRole = data.clone().into();
                    if let Some(role) = server.roles.get_mut(role_id) {
                        for field in &clear.clone() {
                            role.remove_field(&field.clone().into());
                        }

                        role.apply_options(partial);
                    } else {
                        let mut role = Role {
                            id: role_id.clone(),
                            name: partial.name.clone().unwrap_or_default(),
                            permissions: partial.permissions.unwrap_or_default(),
                            colour: None,
                            hoist: partial.hoist.unwrap_or(false),
                            mentionable: partial.mentionable.unwrap_or(true),
                            rank: partial.rank.unwrap_or(0),
                            icon: None,
                        };

                        for field in &clear.clone() {
                            role.remove_field(&field.clone().into());
                        }

                        role.apply_options(partial);
                        server.roles.insert(role_id.clone(), role);
                    }
                }

                if data.rank.is_some() || data.permissions.is_some() {
                    if let Some(member) = self.cache.current_membership(id) {
                        if member.roles.contains(role_id) {
                            queue_server = Some(id.clone());
                        }
                    }
                }
                refresh_authorization = true;
            }
            EventV1::ServerRoleDelete { id, role_id } => {
                if let Some(server) = self.cache.servers.get_mut(id) {
                    server.roles.remove(role_id);
                }
                refresh_authorization = true;

                if let Some(member) = self.cache.current_membership(id) {
                    if member.roles.contains(role_id) {
                        queue_server = Some(id.clone());
                    }
                }
            }
            EventV1::ServerRoleRanksUpdate { id, ranks } => {
                if let Some(server) = self.cache.servers.get_mut(id) {
                    for (rank, role_id) in ranks.iter().enumerate() {
                        if let Some(role) = server.roles.get_mut(role_id) {
                            role.rank = rank as i64;
                        }
                    }
                }
                refresh_authorization = true;

                if let Some(member) = self.cache.current_membership(id) {
                    if ranks.iter().any(|role_id| member.roles.contains(role_id)) {
                        queue_server = Some(id.clone());
                    }
                }
            }

            EventV1::UserUpdate {
                id, data, event_id, ..
            } => {
                if let Some(id) = event_id {
                    if self.cache.seen_events.contains(id) {
                        return false;
                    }

                    self.cache.seen_events.put(id.to_string(), ());
                }

                *event_id = None;
                let affects_authorization =
                    data.privileged.is_some() || data.bot.is_some() || data.relations.is_some();
                if affects_authorization {
                    if let Ok(user) = db.fetch_user(id).await {
                        self.cache.users.insert(id.clone(), user);
                    }
                    refresh_authorization = true;
                }
            }
            EventV1::UserRelationship { id, user, .. } => {
                if let Ok(perspective) = db.fetch_user(&self.cache.user_id).await {
                    self.cache
                        .users
                        .insert(self.cache.user_id.clone(), perspective);
                }
                let target = db
                    .fetch_user(id)
                    .await
                    .unwrap_or_else(|_| user.clone().into());
                self.cache.users.insert(id.clone(), target);

                if self.cache.can_subscribe_to_user(id) {
                    self.insert_subscription(id.clone()).await;
                } else {
                    self.remove_subscription(id).await;
                }
                refresh_authorization = true;
            }

            EventV1::VoiceAuthorityMove { lease, .. } => {
                let channel_id = lease.channel_id.clone();
                refresh_authorization = true;

                if let Some(server_id) = self
                    .cache
                    .channels
                    .get(&channel_id)
                    .and_then(Channel::server)
                    .map(str::to_owned)
                {
                    queue_server = Some(server_id);
                } else {
                    match db.fetch_channels(std::slice::from_ref(&channel_id)).await {
                        Ok(channels) => {
                            if let Some(channel) = channels.into_iter().next() {
                                let can_view = self
                                    .cache
                                    .can_view_voice_move_destination(db, &channel)
                                    .await;
                                if can_view {
                                    // Do not immediately run the ordinary server
                                    // recalculation: the durable voice-session
                                    // projection may still lag behind this trusted
                                    // authority event and would remove the channel.
                                    self.cache
                                        .channels
                                        .insert(channel_id.clone(), channel.clone());
                                    self.insert_subscription(channel_id).await;

                                    let original =
                                        std::mem::replace(event, EventV1::Bulk { v: vec![] });
                                    *event = EventV1::Bulk {
                                        v: vec![EventV1::ChannelCreate(channel.into()), original],
                                    };
                                }
                            } else {
                                warn!(
                                    "VoiceAuthorityMove destination {channel_id} was absent from the channel lookup"
                                );
                            }
                        }
                        Err(error) => {
                            warn!(
                                "Failed to recover VoiceAuthorityMove destination {channel_id}: {error:?}"
                            );
                        }
                    }
                }
            }
            EventV1::VoiceChannelMove { user, to, .. } if user == &self.cache.user_id => {
                refresh_authorization = true;
                queue_server = self
                    .cache
                    .channels
                    .get(to)
                    .and_then(Channel::server)
                    .map(str::to_owned);
            }
            EventV1::VoiceChannelLeave { id, user, .. } if user == &self.cache.user_id => {
                refresh_authorization = true;
                queue_server = self
                    .cache
                    .channels
                    .get(id)
                    .and_then(Channel::server)
                    .map(str::to_owned);
            }

            EventV1::Message(message) => {
                // Since Message events are fanned out to many clients,
                // we must reconstruct the relationship value at this end.
                if let Some(user) = &mut message.user {
                    user.relationship = self
                        .cache
                        .users
                        .get(&self.cache.user_id)
                        .expect("missing self?")
                        .relationship_with(&message.author)
                        .into();
                }
            }

            _ => {}
        }

        // Calculate server permissions if requested.
        if let Some(server_id) = queue_server.as_deref() {
            self.recalculate_server(db, server_id, event).await;
        }

        // Sub / unsub accordingly.
        if let Some(id) = queue_add {
            self.insert_subscription(id).await;
        }

        if let Some(id) = queue_remove {
            self.remove_subscription(&id).await;
        }

        if refresh_authorization && self.authorization_enabled {
            let snapshot = self.next_authorization_snapshot(db).await;
            let authorization_event = EventV1::AuthorizationSnapshot { snapshot };
            match event {
                EventV1::Bulk { v } => v.push(authorization_event),
                _ => {
                    let original = std::mem::replace(event, EventV1::Bulk { v: vec![] });
                    *event = EventV1::Bulk {
                        v: vec![original, authorization_event],
                    };
                }
            }
        }

        true
    }
}
