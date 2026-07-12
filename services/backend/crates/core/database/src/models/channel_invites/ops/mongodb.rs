use futures::StreamExt;
use syrnike_result::Result;

use crate::Invite;
use crate::MongoDb;
use bson::Document;
use mongodb::options::ReturnDocument;

use super::AbstractChannelInvites;

static COL: &str = "channel_invites";

#[async_trait]
impl AbstractChannelInvites for MongoDb {
    /// Insert a new invite into the database
    async fn insert_invite(&self, invite: &Invite) -> Result<()> {
        query!(self, insert_one, COL, &invite).map(|_| ())
    }

    /// Fetch an invite by the code
    async fn fetch_invite(&self, code: &str) -> Result<Invite> {
        query!(self, find_one_by_id, COL, code)?.ok_or_else(|| create_error!(NotFound))
    }

    /// Fetch all invites for a server
    async fn fetch_invites_for_server(&self, server_id: &str) -> Result<Vec<Invite>> {
        Ok(self
            .col::<Invite>(COL)
            .find(doc! {
                "server": server_id,
            })
            .await
            .map_err(|_| create_database_error!("find", COL))?
            .filter_map(|s| async {
                if cfg!(debug_assertions) {
                    Some(s.unwrap())
                } else {
                    s.ok()
                }
            })
            .collect()
            .await)
    }

    /// Delete an invite by its code
    async fn delete_invite(&self, code: &str) -> Result<()> {
        query!(self, delete_one_by_id, COL, code).map(|_| ())
    }

    async fn consume_invite_use(&self, code: &str, now: u64) -> Result<Invite> {
        let now =
            i64::try_from(now).map_err(|_| create_database_error!("encode_timestamp", COL))?;
        let invite = self
            .col::<Invite>(COL)
            .find_one_and_update(
                doc! {
                    "_id": code,
                    "revoked_at": null,
                    "$and": [
                        {
                            "$or": [
                                { "expires_at": null },
                                { "expires_at": { "$gt": now } },
                            ]
                        },
                        {
                            "$or": [
                                { "max_uses": null },
                                { "$expr": { "$lt": ["$uses", "$max_uses"] } },
                            ]
                        },
                    ],
                },
                doc! {
                    "$inc": {
                        "uses": 1_i64
                    }
                },
            )
            .return_document(ReturnDocument::After)
            .await
            .map_err(|_| create_database_error!("find_one_and_update", COL))?;

        match invite {
            Some(invite) => Ok(invite),
            None => match self.fetch_invite(code).await {
                Ok(_) => Err(create_error!(InvalidInvite)),
                Err(error) => Err(error),
            },
        }
    }

    async fn release_invite_use(&self, code: &str) -> Result<()> {
        self.col::<Document>(COL)
            .update_one(
                doc! {
                    "_id": code,
                    "uses": { "$gt": 0_i64 },
                },
                doc! {
                    "$inc": {
                        "uses": -1_i64
                    }
                },
            )
            .await
            .map_err(|_| create_database_error!("update_one", COL))?;

        Ok(())
    }

    async fn revoke_invite(&self, code: &str, revoked_at: u64, revoked_by: &str) -> Result<Invite> {
        self.col::<Document>(COL)
            .update_one(
                doc! {
                    "_id": code
                },
                doc! {
                    "$set": {
                        "revoked_at": revoked_at as i64,
                        "revoked_by": revoked_by,
                    }
                },
            )
            .await
            .map_err(|_| create_database_error!("update_one", COL))?;

        self.fetch_invite(code).await
    }
}

#[cfg(test)]
mod tests {
    use crate::{Database, DatabaseInfo, Invite};

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
    async fn mongodb_revoke_invite_updates_lifecycle_fields() {
        if std::env::var("TEST_DB").as_deref() != Ok("MONGODB") {
            return;
        }

        let db = DatabaseInfo::Test("mongodb_revoke_invite_updates_lifecycle_fields".to_string())
            .connect()
            .await
            .expect("database connection");

        if !matches!(db, Database::MongoDb(_)) {
            return;
        }

        db.drop_database().await;
        db.insert_invite(&invite()).await.expect("invite inserted");

        let revoked = db
            .revoke_invite("invite-1", 2_000, "moderator-1")
            .await
            .expect("invite revoked");
        match revoked {
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

        let server_invites = db
            .fetch_invites_for_server("server-1")
            .await
            .expect("server invites fetched");
        assert!(server_invites
            .iter()
            .any(|invite| invite.code() == "invite-1"));

        db.drop_database().await;
    }

    #[async_std::test]
    async fn mongodb_consume_invite_use_is_atomic_at_limit() {
        if std::env::var("TEST_DB").as_deref() != Ok("MONGODB") {
            return;
        }

        let db = DatabaseInfo::Test("mongodb_consume_invite_use_is_atomic_at_limit".to_string())
            .connect()
            .await
            .expect("database connection");

        if !matches!(db, Database::MongoDb(_)) {
            return;
        }

        db.drop_database().await;
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

        db.release_invite_use("invite-1")
            .await
            .expect("invite use released");
        db.release_invite_use("invite-1")
            .await
            .expect("zero use release is a no-op");
        match db.fetch_invite("invite-1").await.expect("invite fetched") {
            Invite::Server { uses, .. } => assert_eq!(uses, 0),
            _ => unreachable!("expected server invite"),
        }

        db.revoke_invite("invite-1", 2_000, "moderator-1")
            .await
            .expect("invite revoked");
        let error = db
            .consume_invite_use("invite-1", 2_001)
            .await
            .expect_err("revoked invite rejected");
        assert!(matches!(
            error.error_type,
            syrnike_result::ErrorType::InvalidInvite
        ));

        db.drop_database().await;
    }
}
