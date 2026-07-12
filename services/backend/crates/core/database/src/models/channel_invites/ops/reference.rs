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
                Invite::Server { server, .. } => server == server_id,
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

    async fn consume_invite_use(&self, code: &str, now: u64) -> Result<Invite> {
        let mut invites = self.channel_invites.lock().await;
        let invite = invites
            .get_mut(code)
            .ok_or_else(|| create_error!(NotFound))?;

        if invite.is_revoked() || invite.is_expired(now) || invite.is_exhausted() {
            return Err(create_error!(InvalidInvite));
        }

        match invite {
            Invite::Server { uses, .. } | Invite::Group { uses, .. } => {
                *uses = uses
                    .checked_add(1)
                    .ok_or_else(|| create_error!(InternalError))?;
            }
        }

        Ok(invite.clone())
    }

    async fn release_invite_use(&self, code: &str) -> Result<()> {
        let mut invites = self.channel_invites.lock().await;
        let Some(invite) = invites.get_mut(code) else {
            return Ok(());
        };

        match invite {
            Invite::Server { uses, .. } | Invite::Group { uses, .. } => {
                *uses = uses.saturating_sub(1);
            }
        }

        Ok(())
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
    async fn reference_consume_invite_use_is_atomic_at_limit() {
        let db = Database::Reference(ReferenceDb::default());
        let mut limited = invite();
        if let Invite::Server { max_uses, .. } = &mut limited {
            *max_uses = Some(1);
        }
        db.insert_invite(&limited).await.expect("invite inserted");

        let results =
            futures::future::join_all((0..32).map(|_| db.consume_invite_use("invite-1", 1_500)))
                .await;

        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(error) if matches!(error.error_type, syrnike_result::ErrorType::InvalidInvite)))
                .count(),
            31
        );

        match db.fetch_invite("invite-1").await.expect("invite fetched") {
            Invite::Server { uses, .. } => assert_eq!(uses, 1),
            _ => unreachable!("expected server invite"),
        }
    }

    #[async_std::test]
    async fn reference_consume_invite_use_checks_lifecycle_and_release_is_guarded() {
        let db = Database::Reference(ReferenceDb::default());
        db.insert_invite(&invite()).await.expect("invite inserted");

        let consumed = db
            .consume_invite_use("invite-1", 1_500)
            .await
            .expect("invite consumed");
        assert!(matches!(consumed, Invite::Server { uses: 1, .. }));

        db.revoke_invite("invite-1", 2_000, "moderator-1")
            .await
            .expect("invite revoked");
        db.release_invite_use("invite-1")
            .await
            .expect("invite use released");
        db.release_invite_use("invite-1")
            .await
            .expect("zero use release is a no-op");
        db.release_invite_use("missing")
            .await
            .expect("missing invite release is a no-op");

        match db.fetch_invite("invite-1").await.expect("invite fetched") {
            Invite::Server { uses, .. } => assert_eq!(uses, 0),
            _ => unreachable!("expected server invite"),
        }

        let error = db
            .consume_invite_use("invite-1", 2_001)
            .await
            .expect_err("revoked invite rejected");
        assert!(matches!(
            error.error_type,
            syrnike_result::ErrorType::InvalidInvite
        ));
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

    #[async_std::test]
    async fn reference_fetch_invites_for_server_includes_revoked_server_invites() {
        let db = Database::Reference(ReferenceDb::default());
        let active = invite();
        let revoked = Invite::Server {
            code: "invite-revoked".to_string(),
            server: "server-1".to_string(),
            creator: "creator-1".to_string(),
            channel: "channel-1".to_string(),
            created_at: 1_000,
            expires_at: None,
            max_uses: Some(2),
            uses: 0,
            revoked_at: Some(2_000),
            revoked_by: Some("moderator-1".to_string()),
            temporary: false,
        };
        let group = Invite::Group {
            code: "group-invite".to_string(),
            creator: "creator-1".to_string(),
            channel: "group-1".to_string(),
            created_at: 1_000,
            expires_at: None,
            max_uses: None,
            uses: 0,
            revoked_at: Some(2_000),
            revoked_by: Some("moderator-1".to_string()),
            temporary: false,
        };

        db.insert_invite(&active)
            .await
            .expect("active invite inserted");
        db.insert_invite(&revoked)
            .await
            .expect("revoked invite inserted");
        db.insert_invite(&group)
            .await
            .expect("group invite inserted");

        let invites = db
            .fetch_invites_for_server("server-1")
            .await
            .expect("server invites fetched");
        let mut codes = invites
            .into_iter()
            .map(|invite| invite.code().to_string())
            .collect::<Vec<_>>();
        codes.sort();

        assert_eq!(codes, vec!["invite-1", "invite-revoked"]);
    }
}
