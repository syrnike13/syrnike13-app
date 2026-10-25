use std::{collections::HashSet, str::FromStr, time::Duration};

use crate::{events::client::EventV1, Database, File, RatelimitEvent, AMQP};

use authifier::config::{EmailVerificationConfig, Template};
use futures::future::join_all;
use iso8601_timestamp::Timestamp;
use once_cell::sync::Lazy;
use rand::seq::SliceRandom;
use regex::{Regex, RegexBuilder};
use serde_json::json;
use syrnike_config::{config, FeaturesLimits};
use syrnike_models::v0::{self, UserFlags};
use syrnike_presence::filter_online;
use syrnike_result::{create_error, Result};
use ulid::Ulid;

auto_derived_partial!(
    /// # User
    pub struct User {
        /// Unique Id
        #[serde(rename = "_id")]
        pub id: String,
        /// Username
        pub username: String,
        /// Discriminator
        pub discriminator: String,
        /// Display name
        #[serde(skip_serializing_if = "Option::is_none")]
        pub display_name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        /// Avatar attachment
        pub avatar: Option<File>,
        /// Relationships with other users
        #[serde(skip_serializing_if = "Option::is_none")]
        pub relations: Option<Vec<Relationship>>,

        /// User's current status
        #[serde(skip_serializing_if = "Option::is_none")]
        pub status: Option<UserStatus>,
        /// User's profile page
        #[serde(skip_serializing_if = "Option::is_none")]
        pub profile: Option<UserProfile>,

        /// Enum of user flags
        #[serde(skip_serializing_if = "Option::is_none")]
        pub flags: Option<i32>,
        /// Whether this user is privileged
        #[serde(skip_serializing_if = "crate::if_false", default)]
        pub privileged: bool,
        /// Bot information
        #[serde(skip_serializing_if = "Option::is_none")]
        pub bot: Option<BotInformation>,

        /// Time until user is unsuspended
        #[serde(skip_serializing_if = "Option::is_none")]
        pub suspended_until: Option<Timestamp>,
        /// Who can reach this user; never sent to other users
        #[serde(skip_serializing_if = "Option::is_none")]
        pub privacy: Option<UserPrivacy>,
        /// Last acknowledged policy change
        pub last_acknowledged_policy_change: Timestamp,
    },
    "PartialUser"
);

auto_derived!(
    /// Optional fields on user object
    pub enum FieldsUser {
        Avatar,
        StatusText,
        StatusPresence,
        ProfileContent,
        ProfileBackground,
        DisplayName,

        // internal fields
        Suspension,
        None,
    }

    /// User's relationship with another user (or themselves)
    pub enum RelationshipStatus {
        None,
        User,
        Friend,
        Outgoing,
        Incoming,
        Blocked,
        BlockedOther,
    }

    /// Relationship entry indicating current status with other user
    pub struct Relationship {
        #[serde(rename = "_id")]
        pub id: String,
        pub status: RelationshipStatus,
    }

    /// Presence status
    pub enum Presence {
        /// User is online
        Online,
        /// User is not currently available
        Idle,
        /// User is focusing / will only receive mentions
        Focus,
        /// User is busy / will not receive any notifications
        Busy,
        /// User appears to be offline
        Invisible,
        /// User was marked idle by the system
        SystemIdle,
        /// User is online through a web client
        SystemWebOnline,
        /// User is online through a mobile client
        SystemMobileOnline,
    }

    /// User's active status
    #[derive(Default)]
    pub struct UserStatus {
        /// Custom status text
        #[serde(skip_serializing_if = "Option::is_none")]
        pub text: Option<String>,
        /// Current presence option
        #[serde(skip_serializing_if = "Option::is_none")]
        pub presence: Option<Presence>,
    }

    /// User's profile
    #[derive(Default)]
    pub struct UserProfile {
        /// Text content on user's profile
        #[serde(skip_serializing_if = "Option::is_none")]
        pub content: Option<String>,
        /// Background visible on user's profile
        #[serde(skip_serializing_if = "Option::is_none")]
        pub background: Option<File>,
    }

    /// Who can reach this user
    #[derive(Default)]
    pub struct UserPrivacy {
        /// Servers whose members cannot open direct messages with this user
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        pub dm_restricted_servers: Vec<String>,
        /// Restrict direct messages from members of servers joined from now on
        #[serde(default, skip_serializing_if = "crate::if_false")]
        pub restrict_dms_in_new_servers: bool,
        /// Who can send friend requests
        #[serde(default)]
        pub friend_requests: FriendRequestPrivacy,
    }

    /// Who can send friend requests to this user
    pub struct FriendRequestPrivacy {
        /// Anyone who knows the username
        pub everyone: bool,
        /// Users who share a friend
        pub friends_of_friends: bool,
        /// Users who share a server
        pub server_members: bool,
    }

    /// Bot information for if the user is a bot
    pub struct BotInformation {
        /// Id of the owner of this bot
        pub owner: String,
    }

    /// Enumeration providing a hint to the type of user we are handling
    pub enum UserHint {
        /// Could be either a user or a bot
        Any,
        /// Only match bots
        Bot,
        /// Only match users
        User,
    }
);

impl Default for FriendRequestPrivacy {
    fn default() -> Self {
        Self {
            everyone: true,
            friends_of_friends: true,
            server_members: true,
        }
    }
}

impl User {
    /// Privacy settings, with defaults for users who never changed them
    pub fn privacy(&self) -> UserPrivacy {
        self.privacy.clone().unwrap_or_default()
    }

    /// Whether this user's privacy settings let `sender` send them a friend request
    pub async fn accepts_friend_request_from(&self, db: &Database, sender: &User) -> Result<bool> {
        let sources = self.privacy().friend_requests;

        Ok(sources.everyone
            || (sources.friends_of_friends
                && !db
                    .fetch_mutual_user_ids(&self.id, &sender.id)
                    .await?
                    .is_empty())
            || (sources.server_members
                && !db
                    .fetch_mutual_server_ids(&self.id, &sender.id)
                    .await?
                    .is_empty()))
    }
}

impl Presence {
    pub fn is_online_like(&self) -> bool {
        matches!(
            self,
            Presence::Online | Presence::SystemWebOnline | Presence::SystemMobileOnline
        )
    }

    pub fn is_system_managed(&self) -> bool {
        matches!(
            self,
            Presence::SystemIdle | Presence::SystemWebOnline | Presence::SystemMobileOnline
        )
    }

    pub fn system_activity_presence(
        &self,
        client_kind: syrnike_presence::PresenceClientKind,
    ) -> Option<Presence> {
        if !self.is_online_like() && !matches!(self, Presence::SystemIdle) {
            return None;
        }

        Some(match client_kind {
            syrnike_presence::PresenceClientKind::Web => Presence::SystemWebOnline,
            syrnike_presence::PresenceClientKind::Mobile => Presence::SystemMobileOnline,
            syrnike_presence::PresenceClientKind::Desktop
            | syrnike_presence::PresenceClientKind::Unknown => Presence::Online,
        })
    }

    pub fn system_idle_presence(&self) -> Option<Presence> {
        if self.is_online_like() {
            Some(Presence::SystemIdle)
        } else {
            None
        }
    }
}

pub static DISCRIMINATOR_SEARCH_SPACE: Lazy<HashSet<String>> = Lazy::new(|| {
    let mut set = (2..9999)
        .map(|v| format!("{:0>4}", v))
        .collect::<HashSet<String>>();

    for discrim in [
        123, 1234, 1111, 2222, 3333, 4444, 5555, 6666, 7777, 8888, 9999, 1488,
    ] {
        set.remove(&format!("{:0>4}", discrim));
    }

    set.into_iter().collect()
});

static BLOCKED_USERNAME_PATTERNS: Lazy<Regex> = Lazy::new(|| {
    RegexBuilder::new("`{3}|(discord|rvlt|guilded|stt)\\.gg|(revolt|stoat)\\.chat|https?:\\/\\/")
        .case_insensitive(true)
        .build()
        .unwrap()
});

#[allow(clippy::derivable_impls)]
impl Default for User {
    fn default() -> Self {
        Self {
            id: Default::default(),
            username: Default::default(),
            discriminator: Default::default(),
            display_name: Default::default(),
            avatar: Default::default(),
            relations: Default::default(),
            status: Default::default(),
            profile: Default::default(),
            flags: Default::default(),
            privileged: Default::default(),
            bot: Default::default(),
            suspended_until: Default::default(),
            privacy: Default::default(),
            last_acknowledged_policy_change: Timestamp::UNIX_EPOCH,
        }
    }
}

#[allow(clippy::disallowed_methods)]
impl User {
    /// Create a new user
    pub async fn create<I, D>(
        db: &Database,
        username: String,
        account_id: I,
        data: D,
    ) -> Result<User>
    where
        I: Into<Option<String>>,
        D: Into<Option<PartialUser>>,
    {
        let new_username = User::sanitise_username(&username).await?;
        User::validate_username(&new_username)?;

        let mut user = User {
            id: account_id.into().unwrap_or_else(|| Ulid::new().to_string()),
            discriminator: User::find_discriminator(db, &new_username, None).await?,
            username: new_username.clone(),
            last_acknowledged_policy_change: Timestamp::now_utc(),
            ..Default::default()
        };

        if let Some(data) = data.into() {
            user.apply_options(data);
        }

        db.insert_user(&user).await?;
        Ok(user)
    }

    /// Get limits for this user
    pub async fn limits(&self) -> FeaturesLimits {
        let config = config().await;
        if ulid::Ulid::from_str(&self.id)
            .expect("`ulid`")
            .datetime()
            .elapsed()
            .expect("time went backwards")
            <= Duration::from_secs(3600u64 * config.features.limits.global.new_user_hours as u64)
        {
            config.features.limits.new_user
        } else {
            config.features.limits.default
        }
    }

    /// Get the relationship with another user
    pub fn relationship_with(&self, user_b: &str) -> RelationshipStatus {
        if self.id == user_b {
            return RelationshipStatus::User;
        }

        if let Some(relations) = &self.relations {
            if let Some(relationship) = relations.iter().find(|x| x.id == user_b) {
                return relationship.status.clone();
            }
        }

        RelationshipStatus::None
    }

    pub fn is_friends_with(&self, user_b: &str) -> bool {
        matches!(
            self.relationship_with(user_b),
            RelationshipStatus::Friend | RelationshipStatus::User
        )
    }

    /// Check whether two users have a mutual connection
    ///
    /// This will check if user and user_b share a server or a group.
    pub async fn has_mutual_connection(&self, db: &Database, user_b: &str) -> Result<bool> {
        Ok(!db
            .fetch_mutual_server_ids(&self.id, user_b)
            .await?
            .is_empty()
            || !db
                .fetch_mutual_channel_ids(&self.id, user_b)
                .await?
                .is_empty())
    }

    /// Check if this user can acquire another server
    pub async fn can_acquire_server(&self, db: &Database) -> Result<()> {
        if db.fetch_server_count(&self.id).await? <= self.limits().await.servers {
            Ok(())
        } else {
            Err(create_error!(TooManyServers {
                max: self.limits().await.servers
            }))
        }
    }

    /// Validate a username
    ///
    /// This will check if the username is a blocked name or contains a blocked pattern.
    fn validate_username(username: &str) -> Result<()> {
        let username_lowercase = username.to_lowercase();

        const BLOCKED_USERNAMES: &[&str] = &["admin", "revolt", "stoat"];

        if BLOCKED_USERNAMES.contains(&username_lowercase.as_str())
            || BLOCKED_USERNAME_PATTERNS.is_match(username)
        {
            return Err(create_error!(InvalidUsername));
        }

        Ok(())
    }

    /// Sanitise a username
    ///
    /// This will clean up Unicode homoglyphs and pad to the min username length with underscores.
    async fn sanitise_username(username: &str) -> Result<String> {
        let options = decancer::Options::default().retain_capitalization();
        let mut username = decancer::cure(username, options)
            .map_err(|_| create_error!(InvalidUsername))?
            .to_string();

        let config = syrnike_config::config().await;
        let username_length_diff = config
            .api
            .users
            .min_username_length
            .saturating_sub(username.len());
        if username_length_diff > 0 {
            username.push_str(&"_".repeat(username_length_diff))
        }

        Ok(username)
    }

    /// Find a user and session ID from a given token and hint
    #[async_recursion]
    pub async fn from_token(db: &Database, token: &str, hint: UserHint) -> Result<(User, String)> {
        match hint {
            UserHint::Bot => Ok((
                db.fetch_user(
                    &db.fetch_bot_by_token(token)
                        .await
                        .map_err(|_| create_error!(InvalidSession))?
                        .id,
                )
                .await?,
                String::new(),
            )),
            UserHint::User => {
                let session = db.fetch_session_by_token(token).await?;
                Ok((db.fetch_user(&session.user_id).await?, session.id))
            }
            UserHint::Any => {
                if let Ok(result) = User::from_token(db, token, UserHint::User).await {
                    Ok(result)
                } else {
                    User::from_token(db, token, UserHint::Bot).await
                }
            }
        }
    }

    /// Helper function to fetch many users as a mutually connected user
    /// (while optimising the online ID query)
    pub async fn fetch_many_ids_as_mutuals(
        db: &Database,
        perspective: &User,
        ids: &[String],
    ) -> Result<Vec<v0::User>> {
        let online_ids = filter_online(ids).await;

        Ok(
            join_all(db.fetch_users(ids).await?.into_iter().map(|user| async {
                let is_online = online_ids.contains(&user.id);
                user.into_known(perspective, is_online).await
            }))
            .await,
        )
    }

    /// Find a free discriminator for a given username
    pub async fn find_discriminator(
        db: &Database,
        username: &str,
        preferred: Option<(String, String)>,
    ) -> Result<String> {
        let search_space: &HashSet<String> = &DISCRIMINATOR_SEARCH_SPACE;
        let used_discriminators: HashSet<String> = db
            .fetch_discriminators_in_use(username)
            .await?
            .into_iter()
            .collect();

        let available_discriminators: Vec<&String> =
            search_space.difference(&used_discriminators).collect();

        if available_discriminators.is_empty() {
            return Err(create_error!(UsernameTaken));
        }

        if let Some((preferred, target_id)) = preferred {
            if available_discriminators.contains(&&preferred) {
                return Ok(preferred);
            } else {
                if db
                    .has_ratelimited(
                        &target_id,
                        crate::RatelimitEventType::DiscriminatorChange,
                        Duration::from_secs(60 * 60 * 24),
                        1,
                    )
                    .await?
                {
                    return Err(create_error!(DiscriminatorChangeRatelimited));
                }

                RatelimitEvent::create(
                    db,
                    target_id,
                    crate::RatelimitEventType::DiscriminatorChange,
                )
                .await?;
            }
        }

        let mut rng = rand::thread_rng();
        Ok(available_discriminators
            .choose(&mut rng)
            .expect("we can assert this has an element")
            .to_string())
    }

    /// Update a user's username
    pub async fn update_username(&mut self, db: &Database, username: String) -> Result<()> {
        let new_username = User::sanitise_username(&username).await?;
        User::validate_username(&new_username)?;

        if self.username.to_lowercase() == new_username.to_lowercase() {
            self.update(
                db,
                PartialUser {
                    username: Some(new_username),
                    ..Default::default()
                },
                vec![],
            )
            .await
        } else {
            self.update(
                db,
                PartialUser {
                    discriminator: Some(
                        User::find_discriminator(
                            db,
                            &new_username,
                            Some((self.discriminator.to_string(), self.id.clone())),
                        )
                        .await?,
                    ),
                    username: Some(new_username),
                    ..Default::default()
                },
                vec![],
            )
            .await
        }
    }

    /// Set a relationship to another user
    pub async fn set_relationship(
        &mut self,
        db: &Database,
        user_b: &User,
        status: RelationshipStatus,
    ) -> Result<()> {
        db.set_relationship(&self.id, &user_b.id, &status).await?;

        if let RelationshipStatus::None | RelationshipStatus::User = status {
            if let Some(relations) = &mut self.relations {
                relations.retain(|relation| relation.id != user_b.id);
            }
        } else {
            let relation = Relationship {
                id: user_b.id.to_string(),
                status,
            };

            if let Some(relations) = &mut self.relations {
                relations.retain(|relation| relation.id != user_b.id);
                relations.push(relation);
            } else {
                self.relations = Some(vec![relation]);
            }
        }

        Ok(())
    }

    /// Apply a certain relationship between two users
    pub async fn apply_relationship(
        &mut self,
        db: &Database,
        target: &mut User,
        local: RelationshipStatus,
        remote: RelationshipStatus,
    ) -> Result<()> {
        target.set_relationship(db, self, remote).await?;
        self.set_relationship(db, target, local).await?;
        self.publish_relationship(db, target).await;

        Ok(())
    }

    /// Tell both users about their current relationship with each other
    async fn publish_relationship(&self, db: &Database, target: &User) {
        EventV1::UserRelationship {
            id: target.id.clone(),
            user: self.clone().into(db, Some(&*target)).await,
        }
        .private(target.id.clone())
        .await;

        EventV1::UserRelationship {
            id: self.id.clone(),
            user: target.clone().into(db, Some(&*self)).await,
        }
        .private(self.id.clone())
        .await;
    }

    /// Add another user as a friend, or accept their friend request
    pub async fn add_friend(
        &mut self,
        db: &Database,
        amqp: &AMQP,
        target: &mut User,
    ) -> Result<()> {
        self.change_relationship(db, Some(amqp), target, RelationshipChange::AddFriend)
            .await
    }

    /// Remove another user as a friend, or cancel a pending friend request
    pub async fn remove_friend(&mut self, db: &Database, target: &mut User) -> Result<()> {
        self.change_relationship(db, None, target, RelationshipChange::RemoveFriend)
            .await
    }

    /// Block another user
    pub async fn block_user(&mut self, db: &Database, target: &mut User) -> Result<()> {
        self.change_relationship(db, None, target, RelationshipChange::Block)
            .await
    }

    /// Unblock another user
    pub async fn unblock_user(&mut self, db: &Database, target: &mut User) -> Result<()> {
        self.change_relationship(db, None, target, RelationshipChange::Unblock)
            .await
    }

    /// Apply a relationship change while holding the lock for this pair of users.
    ///
    /// Both users are re-read under the lock, so concurrent requests from either
    /// side are applied one after another against the current stored state.
    /// Notifications are sent after the lock is released.
    async fn change_relationship(
        &mut self,
        db: &Database,
        amqp: Option<&AMQP>,
        target: &mut User,
        change: RelationshipChange,
    ) -> Result<()> {
        if self.id == target.id {
            return Err(create_error!(NoEffect));
        }

        let lock_key = if self.id < target.id {
            format!("relationship_lock:{}:{}", self.id, target.id)
        } else {
            format!("relationship_lock:{}:{}", target.id, self.id)
        };

        let (user, other, previous) = crate::util::lock::with_lock(db, &lock_key, || async {
            let mut user = db.fetch_user(&self.id).await?;
            let mut other = db.fetch_user(&target.id).await?;
            let local = user.relationship_with(&other.id);
            let remote = other.relationship_with(&user.id);
            let (next_local, next_remote) = next_relationship(change, &local, &remote)?;

            if next_local == RelationshipStatus::Outgoing && local != RelationshipStatus::Outgoing {
                let outgoing = user
                    .relations
                    .as_ref()
                    .map(|relations| {
                        relations
                            .iter()
                            .filter(|r| r.status == RelationshipStatus::Outgoing)
                            .count()
                    })
                    .unwrap_or_default();

                let max = user.limits().await.outgoing_friend_requests;
                if outgoing >= max {
                    return Err(create_error!(TooManyPendingFriendRequests { max }));
                }

                if !other.accepts_friend_request_from(db, &user).await? {
                    return Err(create_error!(FriendRequestRejected));
                }
            }

            other.set_relationship(db, &user, next_remote).await?;
            user.set_relationship(db, &other, next_local).await?;
            Ok((user, other, local))
        })
        .await?;

        if let Some(amqp) = amqp {
            match (user.relationship_with(&other.id), previous) {
                (RelationshipStatus::Friend, RelationshipStatus::Friend) => {}
                (RelationshipStatus::Friend, _) => {
                    _ = amqp.friend_request_accepted(&user, &other).await;
                }
                (RelationshipStatus::Outgoing, RelationshipStatus::Outgoing) => {}
                (RelationshipStatus::Outgoing, _) => {
                    _ = amqp.friend_request_received(&other, &user).await;
                }
                _ => {}
            }
        }

        user.publish_relationship(db, &other).await;

        *self = user;
        *target = other;
        Ok(())
    }

    /// Update user data
    pub async fn update(
        &mut self,
        db: &Database,
        partial: PartialUser,
        remove: Vec<FieldsUser>,
    ) -> Result<()> {
        for field in &remove {
            self.remove_field(field);
        }

        self.apply_options(partial.clone());
        db.update_user(&self.id, &partial, remove.clone()).await?;

        EventV1::UserUpdate {
            id: self.id.clone(),
            data: partial.into(),
            clear: remove.into_iter().map(|v| v.into()).collect(),
            event_id: Some(Ulid::new().to_string()),
        }
        .p_user(self.id.clone(), db)
        .await;

        Ok(())
    }

    pub fn presence(&self) -> Presence {
        self.status
            .as_ref()
            .and_then(|status| status.presence.clone())
            .unwrap_or(Presence::Online)
    }

    async fn apply_system_presence(&mut self, db: &Database, presence: Presence) -> Result<bool> {
        if self.presence() == presence {
            return Ok(false);
        }

        let mut status = self.status.clone().unwrap_or_default();
        status.presence = Some(presence);

        self.update(
            db,
            PartialUser {
                status: Some(status),
                ..Default::default()
            },
            vec![],
        )
        .await?;

        Ok(true)
    }

    pub async fn apply_system_activity_presence(
        &mut self,
        db: &Database,
        client_kind: syrnike_presence::PresenceClientKind,
    ) -> Result<bool> {
        let Some(presence) = self.presence().system_activity_presence(client_kind) else {
            return Ok(false);
        };

        self.apply_system_presence(db, presence).await
    }

    pub async fn apply_system_idle_presence(&mut self, db: &Database) -> Result<bool> {
        let Some(presence) = self.presence().system_idle_presence() else {
            return Ok(false);
        };

        self.apply_system_presence(db, presence).await
    }

    /// Remove a field from User object
    pub fn remove_field(&mut self, field: &FieldsUser) {
        match field {
            FieldsUser::Avatar => self.avatar = None,
            FieldsUser::StatusText => {
                if let Some(x) = self.status.as_mut() {
                    x.text = None;
                }
            }
            FieldsUser::StatusPresence => {
                if let Some(x) = self.status.as_mut() {
                    x.presence = None;
                }
            }
            FieldsUser::ProfileContent => {
                if let Some(x) = self.profile.as_mut() {
                    x.content = None;
                }
            }
            FieldsUser::ProfileBackground => {
                if let Some(x) = self.profile.as_mut() {
                    x.background = None;
                }
            }
            FieldsUser::DisplayName => self.display_name = None,
            FieldsUser::Suspension => self.suspended_until = None,
            FieldsUser::None => {}
        }
    }

    /// Suspend the user
    ///
    /// - If a duration is specified, the user will be automatically unsuspended after the given time.
    /// - If a reason is specified, an email will be sent.
    pub async fn suspend(
        &mut self,
        db: &Database,
        duration_days: Option<usize>,
        reason: Option<Vec<String>>,
    ) -> Result<()> {
        let authifier = db.clone().to_authifier().await;
        let mut account = authifier
            .database
            .find_account(&self.id)
            .await
            .map_err(|_| create_error!(InternalError))?;

        account
            .disable(&authifier)
            .await
            .map_err(|_| create_error!(InternalError))?;

        account
            .delete_all_sessions(&authifier, None)
            .await
            .map_err(|_| create_error!(InternalError))?;

        self.update(
            db,
            PartialUser {
                flags: Some(UserFlags::SuspendedUntil as i32),
                suspended_until: duration_days.and_then(|dur| {
                    Timestamp::now_utc().checked_add(iso8601_timestamp::Duration::days(dur as i64))
                }),
                ..Default::default()
            },
            vec![],
        )
        .await?;

        if let Some(reason) = reason {
            if let EmailVerificationConfig::Enabled { smtp, .. } =
                authifier.config.email_verification
            {
                smtp.send_email(
                    account.email.clone(),
                    // maybe move this to common area?
                    &Template {
                        title: "Account Suspension".to_string(),
                        html: Some(include_str!("../../../templates/suspension.html").to_owned()),
                        text: include_str!("../../../templates/suspension.txt").to_owned(),
                        url: Default::default(),
                    },
                    json!({
                        "email": account.email,
                        "list": reason.join(", "),
                        "duration": duration_days,
                        "duration_display": if duration_days.is_some() {
                            "block"
                        } else {
                            "none"
                        }
                    }),
                )
                .map_err(|_| create_error!(InternalError))?;
            }
        }

        Ok(())
    }

    /// Unsuspend the user
    pub async fn unsuspend(&mut self, db: &Database) -> Result<()> {
        self.update(
            db,
            PartialUser {
                flags: Some(0),
                suspended_until: None,
                ..Default::default()
            },
            vec![],
        )
        .await?;

        unimplemented!()
    }

    /// Permanently ban the user
    ///
    /// - If a reason is specified, an email will be sent.
    pub async fn ban(&mut self, _db: &Database, _reason: Option<String>) -> Result<()> {
        // Send ban email (if reason provided)
        unimplemented!()
    }

    /// Mark as deleted
    pub async fn mark_deleted(&mut self, db: &Database) -> Result<()> {
        self.update(
            db,
            PartialUser {
                username: Some(format!("Deleted User {}", self.id)),
                flags: Some(2),
                ..Default::default()
            },
            vec![
                FieldsUser::Avatar,
                FieldsUser::StatusText,
                FieldsUser::StatusPresence,
                FieldsUser::ProfileContent,
                FieldsUser::ProfileBackground,
                FieldsUser::Suspension,
            ],
        )
        .await
    }
}

/// Relationship change requested by one user towards another
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RelationshipChange {
    AddFriend,
    RemoveFriend,
    Block,
    Unblock,
}

/// Compute the next `(local, remote)` relationship pair, where `local` is the
/// acting user's entry and `remote` is the other user's entry.
///
/// The decision uses both stored sides, so a pair left half-written by an
/// earlier failure is repaired by the next change instead of getting stuck.
fn next_relationship(
    change: RelationshipChange,
    local: &RelationshipStatus,
    remote: &RelationshipStatus,
) -> Result<(RelationshipStatus, RelationshipStatus)> {
    use RelationshipStatus::*;

    let we_block = *local == Blocked;
    let they_block = *remote == Blocked;

    match change {
        RelationshipChange::AddFriend => {
            if we_block {
                Err(create_error!(Blocked))
            } else if they_block {
                Err(create_error!(FriendRequestRejected))
            } else if *local == Friend && *remote == Friend {
                Err(create_error!(AlreadyFriends))
            } else if *local == Friend
                || *remote == Friend
                || *local == Incoming
                || *remote == Outgoing
            {
                // Accept their request, including crossed requests sent at the same time.
                Ok((Friend, Friend))
            } else if *local == Outgoing && *remote == Incoming {
                Err(create_error!(AlreadySentRequest))
            } else {
                Ok((Outgoing, Incoming))
            }
        }
        RelationshipChange::RemoveFriend => {
            if we_block || they_block {
                Err(create_error!(NoEffect))
            } else if matches!(local, Friend | Outgoing | Incoming)
                || matches!(remote, Friend | Outgoing | Incoming)
            {
                Ok((None, None))
            } else {
                Err(create_error!(NoEffect))
            }
        }
        RelationshipChange::Block => {
            if we_block && matches!(remote, Blocked | BlockedOther) {
                Err(create_error!(NoEffect))
            } else if they_block {
                Ok((Blocked, Blocked))
            } else {
                Ok((Blocked, BlockedOther))
            }
        }
        RelationshipChange::Unblock => {
            if !we_block {
                Err(create_error!(NoEffect))
            } else if they_block {
                Ok((BlockedOther, Blocked))
            } else {
                Ok((None, None))
            }
        }
    }
}

#[cfg(test)]
mod relationship_tests {
    use super::{next_relationship, RelationshipChange::*};
    use crate::RelationshipStatus::{self, *};

    fn next(
        change: super::RelationshipChange,
        local: RelationshipStatus,
        remote: RelationshipStatus,
    ) -> Option<(RelationshipStatus, RelationshipStatus)> {
        next_relationship(change, &local, &remote).ok()
    }

    #[test]
    fn friend_requests_follow_both_sides() {
        assert_eq!(next(AddFriend, None, None), Some((Outgoing, Incoming)));
        assert_eq!(next(AddFriend, Incoming, Outgoing), Some((Friend, Friend)));
        assert_eq!(next(AddFriend, Outgoing, Incoming), Option::None);
        assert_eq!(next(AddFriend, Friend, Friend), Option::None);
    }

    #[test]
    fn crossed_or_half_written_requests_become_friends() {
        assert_eq!(next(AddFriend, Outgoing, Outgoing), Some((Friend, Friend)));
        assert_eq!(next(AddFriend, None, Outgoing), Some((Friend, Friend)));
        assert_eq!(next(AddFriend, Incoming, None), Some((Friend, Friend)));
        assert_eq!(next(AddFriend, Friend, None), Some((Friend, Friend)));
        assert_eq!(next(AddFriend, Outgoing, None), Some((Outgoing, Incoming)));
    }

    #[test]
    fn blocks_win_over_friend_requests() {
        assert_eq!(next(AddFriend, Blocked, BlockedOther), Option::None);
        assert_eq!(next(AddFriend, BlockedOther, Blocked), Option::None);
        assert_eq!(next(AddFriend, None, Blocked), Option::None);
        assert_eq!(next(RemoveFriend, BlockedOther, Blocked), Option::None);
    }

    #[test]
    fn removing_clears_both_sides() {
        assert_eq!(next(RemoveFriend, Friend, Friend), Some((None, None)));
        assert_eq!(next(RemoveFriend, Outgoing, Incoming), Some((None, None)));
        assert_eq!(next(RemoveFriend, None, Friend), Some((None, None)));
        assert_eq!(next(RemoveFriend, None, None), Option::None);
    }

    #[test]
    fn blocking_and_unblocking_keep_the_other_users_block() {
        assert_eq!(next(Block, Friend, Friend), Some((Blocked, BlockedOther)));
        assert_eq!(next(Block, BlockedOther, Blocked), Some((Blocked, Blocked)));
        assert_eq!(next(Block, Blocked, BlockedOther), Option::None);
        assert_eq!(next(Block, Blocked, None), Some((Blocked, BlockedOther)));
        assert_eq!(
            next(Unblock, Blocked, Blocked),
            Some((BlockedOther, Blocked))
        );
        assert_eq!(next(Unblock, Blocked, BlockedOther), Some((None, None)));
        assert_eq!(next(Unblock, Blocked, None), Some((None, None)));
        assert_eq!(next(Unblock, None, None), Option::None);
    }

    #[async_std::test]
    async fn friend_requests_from_both_sides_become_friends() {
        let db = crate::DatabaseInfo::Reference
            .connect()
            .await
            .expect("reference database");
        let mut alice = crate::User::create(&db, "Alice".to_string(), Option::None, Option::None)
            .await
            .expect("alice");
        let mut bob = crate::User::create(&db, "Bob".to_string(), Option::None, Option::None)
            .await
            .expect("bob");
        let (mut alice_view_of_bob, mut bob_view_of_alice) = (bob.clone(), alice.clone());

        let (alice_result, bob_result) = futures::join!(
            Box::pin(alice.change_relationship(
                &db,
                Option::None,
                &mut alice_view_of_bob,
                AddFriend
            )),
            Box::pin(bob.change_relationship(&db, Option::None, &mut bob_view_of_alice, AddFriend)),
        );
        alice_result.expect("alice request");
        bob_result.expect("bob request");

        let alice = db.fetch_user(&alice.id).await.expect("alice stored");
        let bob = db.fetch_user(&bob.id).await.expect("bob stored");
        assert_eq!(alice.relationship_with(&bob.id), Friend);
        assert_eq!(bob.relationship_with(&alice.id), Friend);
    }

    async fn users_sharing_a_server(
        db: &crate::Database,
    ) -> (crate::User, crate::User, crate::Server) {
        let owner = crate::User::create(db, "Owner".to_string(), Option::None, Option::None)
            .await
            .expect("owner");
        let member = crate::User::create(db, "Member".to_string(), Option::None, Option::None)
            .await
            .expect("member");
        let (server, _) = Box::pin(crate::Server::create(
            db,
            syrnike_models::v0::DataCreateServer {
                name: "Server".to_string(),
                description: Option::None,
                nsfw: Option::None,
            },
            &owner,
            false,
        ))
        .await
        .expect("server");
        for user in [&owner, &member] {
            Box::pin(crate::Member::create(
                db,
                &server,
                user,
                Option::None,
                false,
            ))
            .await
            .expect("membership");
        }

        (owner, member, server)
    }

    async fn set_privacy(db: &crate::Database, user: &crate::User, privacy: crate::UserPrivacy) {
        db.update_user(
            &user.id,
            &crate::PartialUser {
                privacy: Some(privacy),
                ..Default::default()
            },
            vec![],
        )
        .await
        .expect("privacy saved");
    }

    #[async_std::test]
    async fn friend_requests_follow_the_recipients_privacy() {
        let db = crate::DatabaseInfo::Reference
            .connect()
            .await
            .expect("reference database");
        let (owner, member, _) = Box::pin(users_sharing_a_server(&db)).await;
        let stranger = crate::User::create(&db, "Stranger".to_string(), Option::None, Option::None)
            .await
            .expect("stranger");

        set_privacy(
            &db,
            &owner,
            crate::UserPrivacy {
                friend_requests: crate::FriendRequestPrivacy {
                    everyone: false,
                    friends_of_friends: false,
                    server_members: true,
                },
                ..Default::default()
            },
        )
        .await;
        let owner = db.fetch_user(&owner.id).await.expect("owner stored");

        assert!(owner
            .accepts_friend_request_from(&db, &member)
            .await
            .expect("checked"));
        assert!(!owner
            .accepts_friend_request_from(&db, &stranger)
            .await
            .expect("checked"));
    }

    #[async_std::test]
    async fn server_members_can_open_dms_until_the_server_is_restricted() {
        use syrnike_permissions::{calculate_user_permissions, UserPermission};

        let db = crate::DatabaseInfo::Reference
            .connect()
            .await
            .expect("reference database");
        let (owner, member, server) = Box::pin(users_sharing_a_server(&db)).await;
        let can_message = |db: crate::Database, member: crate::User, owner: crate::User| async move {
            let mut query = crate::util::permissions::perms(&db, &member).user(&owner);
            calculate_user_permissions(&mut query)
                .await
                .has_user_permission(UserPermission::SendMessage)
        };

        assert!(Box::pin(can_message(db.clone(), member.clone(), owner.clone())).await);

        set_privacy(
            &db,
            &owner,
            crate::UserPrivacy {
                dm_restricted_servers: vec![server.id.clone()],
                ..Default::default()
            },
        )
        .await;
        let owner = db.fetch_user(&owner.id).await.expect("owner stored");
        assert!(!Box::pin(can_message(db.clone(), member, owner)).await);
    }

    #[async_std::test]
    async fn joining_a_server_can_restrict_its_dms_by_default() {
        let db = crate::DatabaseInfo::Reference
            .connect()
            .await
            .expect("reference database");
        let owner = crate::User::create(&db, "Owner".to_string(), Option::None, Option::None)
            .await
            .expect("owner");
        let joiner = crate::User::create(&db, "Joiner".to_string(), Option::None, Option::None)
            .await
            .expect("joiner");
        set_privacy(
            &db,
            &joiner,
            crate::UserPrivacy {
                restrict_dms_in_new_servers: true,
                ..Default::default()
            },
        )
        .await;
        let joiner = db.fetch_user(&joiner.id).await.expect("joiner stored");
        let (server, _) = Box::pin(crate::Server::create(
            &db,
            syrnike_models::v0::DataCreateServer {
                name: "Server".to_string(),
                description: Option::None,
                nsfw: Option::None,
            },
            &owner,
            false,
        ))
        .await
        .expect("server");

        Box::pin(crate::Member::create(
            &db,
            &server,
            &joiner,
            Option::None,
            false,
        ))
        .await
        .expect("membership");

        let joiner = db.fetch_user(&joiner.id).await.expect("joiner stored");
        assert_eq!(joiner.privacy().dm_restricted_servers, vec![server.id]);
    }
}

#[cfg(test)]
mod tests {
    use crate::{Presence, User};
    use syrnike_presence::PresenceClientKind;

    #[test]
    fn presence_helpers_classify_manual_and_system_states() {
        assert!(Presence::Online.is_online_like());
        assert!(Presence::SystemWebOnline.is_online_like());
        assert!(Presence::SystemMobileOnline.is_online_like());
        assert!(!Presence::SystemIdle.is_online_like());
        assert!(!Presence::Busy.is_online_like());

        assert!(Presence::SystemIdle.is_system_managed());
        assert!(Presence::SystemWebOnline.is_system_managed());
        assert!(Presence::SystemMobileOnline.is_system_managed());
        assert!(!Presence::Online.is_system_managed());
        assert!(!Presence::Idle.is_system_managed());
    }

    #[test]
    fn system_activity_presence_keeps_manual_statuses_manual() {
        assert_eq!(
            Presence::Online.system_activity_presence(PresenceClientKind::Web),
            Some(Presence::SystemWebOnline),
        );
        assert_eq!(
            Presence::SystemIdle.system_activity_presence(PresenceClientKind::Mobile),
            Some(Presence::SystemMobileOnline),
        );
        assert_eq!(
            Presence::SystemIdle.system_activity_presence(PresenceClientKind::Desktop),
            Some(Presence::Online),
        );
        assert_eq!(
            Presence::SystemWebOnline.system_idle_presence(),
            Some(Presence::SystemIdle),
        );
        assert_eq!(
            Presence::Idle.system_activity_presence(PresenceClientKind::Web),
            None
        );
        assert_eq!(Presence::Focus.system_idle_presence(), None);
        assert_eq!(Presence::Busy.system_idle_presence(), None);
        assert_eq!(Presence::Invisible.system_idle_presence(), None);
    }

    #[test]
    fn username_validation_blocked_names() {
        let username_admin = "Admin";
        let username_revolt = "Revolt";
        let username_stoat = "Stoat";
        let username_allowed = "Allowed";

        assert!(User::validate_username(username_admin).is_err());
        assert!(User::validate_username(username_revolt).is_err());
        assert!(User::validate_username(username_stoat).is_err());
        assert!(User::validate_username(username_allowed).is_ok());
    }

    #[test]
    fn username_validation_blocked_patterns() {
        let username_grave = "```_test";
        let username_discord = "discord.gg_test";
        let username_rvlt = "rvlt.gg_test";
        let username_guilded = "guilded.gg_test";
        let username_stt = "stt.gg_test";
        let username_revolt = "revolt.chat_test";
        let username_stoat = "stoat.chat_test";
        let username_http = "http://_test";
        let username_https = "https://_test";

        assert!(User::validate_username(username_grave).is_err());
        assert!(User::validate_username(username_discord).is_err());
        assert!(User::validate_username(username_rvlt).is_err());
        assert!(User::validate_username(username_guilded).is_err());
        assert!(User::validate_username(username_stt).is_err());
        assert!(User::validate_username(username_revolt).is_err());
        assert!(User::validate_username(username_stoat).is_err());
        assert!(User::validate_username(username_http).is_err());
        assert!(User::validate_username(username_https).is_err());
    }

    #[async_std::test]
    async fn username_sanitisation_clean() {
        let username_clean = "Test";

        let username_clean_sanitised = User::sanitise_username(username_clean).await;

        assert!(username_clean_sanitised.is_ok());
        assert_eq!(username_clean, username_clean_sanitised.unwrap());
    }

    #[async_std::test]
    async fn username_sanitisation_homoglyphs() {
        let username_homoglyphs = "𝔽𝕌Ňℕｙ";

        let username_homoglyphs_sanitised =
            User::sanitise_username(username_homoglyphs).await.unwrap();

        assert_ne!(username_homoglyphs, username_homoglyphs_sanitised);
        assert_eq!("funny", username_homoglyphs_sanitised);
    }

    #[async_std::test]
    async fn username_sanitisation_padding() {
        let username_padding = "a";

        let username = User::sanitise_username(username_padding).await.unwrap();

        assert_eq!("a_", username);
    }

    #[async_std::test]
    async fn create_user() {
        use syrnike_result::Result;

        database_test!(|db| async move {
            let mut created_clean = User::create(&db, "Test".to_string(), None, None)
                .await
                .unwrap();

            assert_eq!("Test", created_clean.username);

            created_clean
                .update_username(&db, "Test2".to_string())
                .await
                .unwrap();

            assert_eq!("Test2", created_clean.username);

            let created_invalid_result: Result<_> =
                User::create(&db, "stoat.chat".to_string(), None, None).await;

            assert!(created_invalid_result.is_err());

            let mut updated_invalid = User::create(&db, "Test".to_string(), None, None)
                .await
                .unwrap();

            let updated_invalid_update_result = updated_invalid
                .update_username(&db, "http://test".to_string())
                .await;

            assert!(updated_invalid_update_result.is_err());
        });
    }
}
