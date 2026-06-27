use syrnike_result::{create_error, Result};

use crate::{audit_timestamp, Channel, Database, User};

static ALPHABET: [char; 54] = [
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J',
    'K', 'M', 'N', 'P', 'Q', 'R', 'S', 'T', 'V', 'W', 'X', 'Y', 'Z', 'a', 'b', 'c', 'd', 'e', 'f',
    'g', 'h', 'j', 'k', 'm', 'n', 'p', 'q', 'r', 's', 't', 'v', 'w', 'x', 'y', 'z',
];

auto_derived!(
    /// Invite
    #[serde(tag = "type")]
    pub enum Invite {
        /// Invite to a specific server channel
        Server {
            /// Invite code
            #[serde(rename = "_id")]
            code: String,
            /// Id of the server this invite points to
            server: String,
            /// Id of user who created this invite
            creator: String,
            /// Id of the server channel this invite points to
            channel: String,
            /// Invite creation time in milliseconds since Unix epoch
            created_at: u64,
            /// Invite expiry time in milliseconds since Unix epoch
            expires_at: Option<u64>,
            /// Maximum number of successful joins
            max_uses: Option<u64>,
            /// Number of successful joins through this invite
            uses: u64,
            /// Invite revocation time in milliseconds since Unix epoch
            revoked_at: Option<u64>,
            /// Id of user who revoked this invite
            revoked_by: Option<String>,
            /// Whether membership should be temporary
            temporary: bool,
        },
        /// Invite to a group channel
        Group {
            /// Invite code
            #[serde(rename = "_id")]
            code: String,
            /// Id of user who created this invite
            creator: String,
            /// Id of the group channel this invite points to
            channel: String,
            /// Invite creation time in milliseconds since Unix epoch
            created_at: u64,
            /// Invite expiry time in milliseconds since Unix epoch
            expires_at: Option<u64>,
            /// Maximum number of successful joins
            max_uses: Option<u64>,
            /// Number of successful joins through this invite
            uses: u64,
            /// Invite revocation time in milliseconds since Unix epoch
            revoked_at: Option<u64>,
            /// Id of user who revoked this invite
            revoked_by: Option<String>,
            /// Whether membership should be temporary
            temporary: bool,
        }, /* User {
               code: String,
               user: String
           } */
    }
);

#[allow(clippy::disallowed_methods)]
impl Invite {
    /// Get the invite code for this invite
    pub fn code(&'_ self) -> &'_ str {
        match self {
            Invite::Server { code, .. } | Invite::Group { code, .. } => code,
        }
    }

    /// Get the ID of the user who created this invite
    pub fn creator(&'_ self) -> &'_ str {
        match self {
            Invite::Server { creator, .. } | Invite::Group { creator, .. } => creator,
        }
    }

    pub fn is_revoked(&self) -> bool {
        match self {
            Invite::Server { revoked_at, .. } | Invite::Group { revoked_at, .. } => {
                revoked_at.is_some()
            }
        }
    }

    pub fn is_exhausted(&self) -> bool {
        match self {
            Invite::Server { max_uses, uses, .. } | Invite::Group { max_uses, uses, .. } => {
                max_uses.is_some_and(|max| *uses >= max)
            }
        }
    }

    pub fn is_expired(&self, now: u64) -> bool {
        match self {
            Invite::Server { expires_at, .. } | Invite::Group { expires_at, .. } => {
                expires_at.is_some_and(|expires_at| expires_at <= now)
            }
        }
    }

    /// Create a new invite from given information
    pub fn create_channel_invite(
        creator: &User,
        channel: &Channel,
        max_age_seconds: Option<u64>,
        max_uses: Option<u64>,
        temporary: bool,
    ) -> Result<Invite> {
        let code = nanoid::nanoid!(8, &ALPHABET);
        let created_at = audit_timestamp();
        let expires_at = max_age_seconds.and_then(|seconds| {
            if seconds == 0 {
                None
            } else {
                Some(created_at.saturating_add(seconds.saturating_mul(1_000)))
            }
        });
        let max_uses = max_uses.filter(|uses| *uses > 0);

        let invite = match &channel {
            Channel::Group { id, .. } => Ok(Invite::Group {
                code,
                creator: creator.id.clone(),
                channel: id.clone(),
                created_at,
                expires_at,
                max_uses,
                uses: 0,
                revoked_at: None,
                revoked_by: None,
                temporary,
            }),
            Channel::TextChannel { id, server, .. } => Ok(Invite::Server {
                code,
                creator: creator.id.clone(),
                server: server.clone(),
                channel: id.clone(),
                created_at,
                expires_at,
                max_uses,
                uses: 0,
                revoked_at: None,
                revoked_by: None,
                temporary,
            }),
            _ => Err(create_error!(InvalidOperation)),
        }?;

        Ok(invite)
    }

    /// Resolve an invite by its ID or by a public server ID
    pub async fn find(db: &Database, code: &str) -> Result<Invite> {
        if let Ok(invite) = db.fetch_invite(code).await {
            return Ok(invite);
        } else if let Ok(server) = db.fetch_server(code).await {
            if server.discoverable {
                if let Some(channel) = server.channels.into_iter().next() {
                    return Ok(Invite::Server {
                        code: code.to_string(),
                        server: server.id,
                        creator: server.owner,
                        channel,
                        created_at: audit_timestamp(),
                        expires_at: None,
                        max_uses: None,
                        uses: 0,
                        revoked_at: None,
                        revoked_by: None,
                        temporary: false,
                    });
                }
            }
        }

        Err(create_error!(NotFound))
    }
}

#[cfg(test)]
mod tests {
    use crate::Invite;

    fn invite_with_lifecycle(
        expires_at: Option<u64>,
        max_uses: Option<u64>,
        uses: u64,
        revoked_at: Option<u64>,
    ) -> Invite {
        Invite::Server {
            code: "invite-1".to_string(),
            server: "server-1".to_string(),
            creator: "user-1".to_string(),
            channel: "channel-1".to_string(),
            created_at: 1_000,
            expires_at,
            max_uses,
            uses,
            revoked_at,
            revoked_by: revoked_at.map(|_| "moderator-1".to_string()),
            temporary: false,
        }
    }

    #[test]
    fn invite_lifecycle_helpers_detect_invalid_invites() {
        assert!(invite_with_lifecycle(Some(2_000), None, 0, None).is_expired(2_000));
        assert!(!invite_with_lifecycle(Some(2_000), None, 0, None).is_expired(1_999));
        assert!(invite_with_lifecycle(None, Some(3), 3, None).is_exhausted());
        assert!(!invite_with_lifecycle(None, Some(3), 2, None).is_exhausted());
        assert!(invite_with_lifecycle(None, None, 0, Some(1_500)).is_revoked());
    }
}
