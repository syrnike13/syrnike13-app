use std::{
    collections::{HashMap, HashSet},
    num::NonZeroUsize,
    sync::Arc,
    time::Duration,
};

use async_std::sync::{Mutex, RwLock};
use lru::LruCache;
use lru_time_cache::{LruCache as LruTimeCache, TimedEntry};
use syrnike_database::{Channel, Member, Server, User};

/// Enumeration representing some change in subscriptions
pub enum SubscriptionStateChange {
    /// No change
    None,
    /// Clear all subscriptions
    Reset,
    /// Append or remove subscriptions
    Change {
        add: Vec<String>,
        remove: Vec<String>,
    },
}

/// Dumb per-state cache implementation
///
/// Ideally this would use a global cache that
/// allows for mutations and could use Rc<> to
/// track usage. If Rc<> == 1, then it only
/// remains in global cache, hence should be
/// dropped.
///
/// ------------------------------------------------
/// We can strip these objects to core information!!
/// ------------------------------------------------
#[derive(Debug)]
pub struct Cache {
    pub user_id: String,
    pub is_bot: bool,

    pub users: HashMap<String, User>,
    pub channels: HashMap<String, Channel>,
    current_memberships: HashMap<String, Member>,
    pub servers: HashMap<String, Server>,

    pub seen_events: LruCache<String, ()>,
}

impl Cache {
    /// Return this gateway connection's membership for a server.
    ///
    /// Authorization may only use the connected account's own membership.
    pub(super) fn current_membership(&self, server_id: &str) -> Option<&Member> {
        self.current_memberships
            .get(server_id)
            .filter(|member| member.id.server == server_id && member.id.user == self.user_id)
    }

    pub(super) fn current_membership_mut(&mut self, server_id: &str) -> Option<&mut Member> {
        let user_id = self.user_id.as_str();
        self.current_memberships
            .get_mut(server_id)
            .filter(|member| member.id.server == server_id && member.id.user == user_id)
    }

    /// Replace the connected account's memberships while rejecting foreign members.
    pub(super) fn replace_current_memberships(
        &mut self,
        memberships: impl IntoIterator<Item = Member>,
    ) {
        self.current_memberships.clear();
        for membership in memberships {
            self.upsert_current_membership(membership);
        }
    }

    /// Insert a membership only when it belongs to the connected account.
    pub(super) fn upsert_current_membership(&mut self, membership: Member) {
        if membership.id.user != self.user_id {
            return;
        }

        self.current_memberships
            .insert(membership.id.server.clone(), membership);
    }

    pub(super) fn remove_current_membership(&mut self, server_id: &str) -> Option<Member> {
        self.current_memberships.remove(server_id)
    }
}

impl Default for Cache {
    fn default() -> Self {
        Cache {
            user_id: Default::default(),
            is_bot: false,

            users: Default::default(),
            channels: Default::default(),
            current_memberships: Default::default(),
            servers: Default::default(),

            seen_events: LruCache::new(NonZeroUsize::new(20).unwrap()),
        }
    }
}

/// Client state
pub struct State {
    pub cache: Cache,

    pub session_id: String,
    pub private_topic: String,
    pub state: SubscriptionStateChange,

    pub subscribed: Arc<RwLock<HashSet<String>>>,
    pub active_servers: Arc<Mutex<LruTimeCache<String, ()>>>,
    pub authorization_revision: u64,
    pub authorization_enabled: bool,
}

impl State {
    /// Create state from User
    pub fn from(user: User, session_id: String) -> State {
        let mut subscribed = HashSet::new();
        let private_topic = format!("{}!", user.id);
        subscribed.insert(private_topic.clone());
        subscribed.insert(user.id.clone());

        let mut cache: Cache = Cache {
            user_id: user.id.clone(),
            ..Default::default()
        };

        cache.users.insert(user.id.clone(), user);

        State {
            cache,
            subscribed: Arc::new(RwLock::new(subscribed)),
            active_servers: Arc::new(Mutex::new(LruTimeCache::with_expiry_duration_and_capacity(
                Duration::from_secs(900),
                5,
            ))),
            session_id,
            private_topic,
            state: SubscriptionStateChange::Reset,
            authorization_revision: 0,
            authorization_enabled: false,
        }
    }

    /// Apply currently queued state
    pub async fn apply_state(&mut self) -> SubscriptionStateChange {
        // Check if we need to change subscriptions to member event topics
        if !self.cache.is_bot {
            enum Server {
                Subscribe(String),
                Unsubscribe(String),
            }

            let active_server_changes: Vec<Server> = {
                let mut active_servers = self.active_servers.lock().await;
                active_servers
                    .notify_iter()
                    .map(|e| match e {
                        TimedEntry::Valid(k, _) => Server::Subscribe(format!("{}u", k)),
                        TimedEntry::Expired(k, _) => Server::Unsubscribe(format!("{}u", k)),
                    })
                    .collect()
                // It is bad practice to open more than one Mutex at once and could
                // lead to a deadlock, so instead we choose to collect the changes.
            };

            for entry in active_server_changes {
                match entry {
                    Server::Subscribe(k) => {
                        self.insert_subscription(k).await;
                    }
                    Server::Unsubscribe(k) => {
                        self.remove_subscription(&k).await;
                    }
                }
            }
        }

        // Flush changes to subscriptions
        let state = std::mem::replace(&mut self.state, SubscriptionStateChange::None);
        let mut subscribed = self.subscribed.write().await;
        if let SubscriptionStateChange::Change { add, remove } = &state {
            for id in add {
                subscribed.insert(id.clone());
            }

            for id in remove {
                subscribed.remove(id);
            }
        }

        state
    }

    /// Clone the active user
    pub fn clone_user(&self) -> User {
        self.cache.users.get(&self.cache.user_id).unwrap().clone()
    }

    /// Reset the current state
    pub async fn reset_state(&mut self) {
        self.state = SubscriptionStateChange::Reset;
        self.subscribed.write().await.clear();
    }

    /// Add a new subscription
    pub async fn insert_subscription(&mut self, subscription: String) {
        let mut subscribed = self.subscribed.write().await;
        if subscribed.contains(&subscription) {
            return;
        }

        match &mut self.state {
            SubscriptionStateChange::None => {
                self.state = SubscriptionStateChange::Change {
                    add: vec![subscription.clone()],
                    remove: vec![],
                };
            }
            SubscriptionStateChange::Change { add, .. } => {
                add.push(subscription.clone());
            }
            SubscriptionStateChange::Reset => {}
        }

        subscribed.insert(subscription);
    }

    /// Remove existing subscription
    pub async fn remove_subscription(&mut self, subscription: &str) {
        let mut subscribed = self.subscribed.write().await;
        if !subscribed.contains(&subscription.to_string()) {
            return;
        }

        match &mut self.state {
            SubscriptionStateChange::None => {
                self.state = SubscriptionStateChange::Change {
                    add: vec![],
                    remove: vec![subscription.to_string()],
                };
            }
            SubscriptionStateChange::Change { remove, .. } => {
                remove.push(subscription.to_string());
            }
            SubscriptionStateChange::Reset => panic!("Should not remove during a reset!"),
        }

        subscribed.remove(subscription);
    }
}

#[cfg(test)]
mod tests {
    use syrnike_database::MemberCompositeKey;

    use super::*;

    fn membership(server_id: &str, user_id: &str, roles: &[&str]) -> Member {
        Member {
            id: MemberCompositeKey {
                server: server_id.to_string(),
                user: user_id.to_string(),
            },
            roles: roles.iter().map(|role| (*role).to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn current_memberships_never_accept_foreign_voice_members() {
        let mut cache = Cache {
            user_id: "current-user".to_string(),
            ..Default::default()
        };

        cache.replace_current_memberships([
            membership("server", "current-user", &["admin"]),
            membership("server", "voice-peer", &[]),
        ]);

        assert_eq!(
            cache.current_membership("server").unwrap().roles,
            vec!["admin"]
        );

        cache.upsert_current_membership(membership("server", "voice-admin", &["admin"]));

        let current = cache.current_membership("server").unwrap();
        assert_eq!(current.id.user, "current-user");
        assert_eq!(current.roles, vec!["admin"]);

        cache.replace_current_memberships([
            membership("second-server", "current-user", &[]),
            membership("second-server", "voice-admin", &["admin"]),
        ]);

        let current = cache.current_membership("second-server").unwrap();
        assert_eq!(current.id.user, "current-user");
        assert!(current.roles.is_empty());
    }

    #[test]
    fn current_membership_checks_server_key_identity() {
        let mut cache = Cache {
            user_id: "current-user".to_string(),
            ..Default::default()
        };
        cache.upsert_current_membership(membership("actual-server", "current-user", &["admin"]));

        assert!(cache.current_membership("actual-server").is_some());
        assert!(cache.current_membership("different-server").is_none());
    }
}
