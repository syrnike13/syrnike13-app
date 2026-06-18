use syrnike_result::Result;

use crate::Invite;
use crate::ReferenceDb;

use super::AbstractChannelInvites;

#[async_trait]
impl AbstractChannelInvites for ReferenceDb {
    /// Insert a new invite into the database
    async fn insert_invite(&self, invite: &Invite) -> Result<()> {
        let mut invites = self.channel_invites.lock().await;
        if invites.contains_key(invite.code()) {
            Err(create_database_error!("insert", "invite"))
        } else {
            invites.insert(invite.code().to_string(), invite.clone());
            Ok(())
        }
    }

    /// Fetch an invite by the code
    async fn fetch_invite(&self, code: &str) -> Result<Invite> {
        let invites = self.channel_invites.lock().await;
        invites
            .get(code)
            .cloned()
            .ok_or_else(|| create_error!(NotFound))
    }

    /// Fetch all invites for a server
    async fn fetch_invites_for_server(&self, server_id: &str) -> Result<Vec<Invite>> {
        let invites = self.channel_invites.lock().await;
        Ok(invites
            .values()
            .filter(|invite| match invite {
                Invite::Server { server, .. } => server == server_id && !invite.is_revoked(),
                _ => false,
            })
            .cloned()
            .collect())
    }

    /// Delete an invite by its code
    async fn delete_invite(&self, code: &str) -> Result<()> {
        let mut invites = self.channel_invites.lock().await;
        if invites.remove(code).is_some() {
            Ok(())
        } else {
            Err(create_error!(NotFound))
        }
    }

    async fn increment_invite_uses(&self, code: &str) -> Result<Invite> {
        let mut invites = self.channel_invites.lock().await;
        let invite = invites
            .get_mut(code)
            .ok_or_else(|| create_error!(NotFound))?;

        match invite {
            Invite::Server { uses, .. } | Invite::Group { uses, .. } => {
                *uses = uses.saturating_add(1);
            }
        }

        Ok(invite.clone())
    }

    async fn revoke_invite(&self, code: &str, revoked_at: u64, revoked_by: &str) -> Result<Invite> {
        let mut invites = self.channel_invites.lock().await;
        let invite = invites
            .get_mut(code)
            .ok_or_else(|| create_error!(NotFound))?;

        match invite {
            Invite::Server {
                revoked_at: invite_revoked_at,
                revoked_by: invite_revoked_by,
                ..
            }
            | Invite::Group {
                revoked_at: invite_revoked_at,
                revoked_by: invite_revoked_by,
                ..
            } => {
                *invite_revoked_at = Some(revoked_at);
                *invite_revoked_by = Some(revoked_by.to_string());
            }
        }

        Ok(invite.clone())
    }
}

#[cfg(test)]
mod tests {
    use crate::{Database, Invite, ReferenceDb};

    fn invite() -> Invite {
        Invite::Server {
            code: "invite-1".to_string(),
            server: "server-1".to_string(),
            creator: "creator-1".to_string(),
            channel: "channel-1".to_string(),
            created_at: 1_000,
            expires_at: None,
            max_uses: Some(2),
            uses: 0,
            revoked_at: None,
            revoked_by: None,
            temporary: false,
        }
    }

    #[async_std::test]
    async fn reference_increment_invite_uses_returns_updated_invite() {
        let db = Database::Reference(ReferenceDb::default());
        db.insert_invite(&invite()).await.expect("invite inserted");

        let invite = db
            .increment_invite_uses("invite-1")
            .await
            .expect("invite incremented");

        match invite {
            Invite::Server { uses, .. } => assert_eq!(uses, 1),
            _ => unreachable!("expected server invite"),
        }
    }

    #[async_std::test]
    async fn reference_revoke_invite_returns_updated_invite() {
        let db = Database::Reference(ReferenceDb::default());
        db.insert_invite(&invite()).await.expect("invite inserted");

        let invite = db
            .revoke_invite("invite-1", 2_000, "moderator-1")
            .await
            .expect("invite revoked");

        match invite {
            Invite::Server {
                revoked_at,
                revoked_by,
                ..
            } => {
                assert_eq!(revoked_at, Some(2_000));
                assert_eq!(revoked_by.as_deref(), Some("moderator-1"));
            }
            _ => unreachable!("expected server invite"),
        }
    }
}
