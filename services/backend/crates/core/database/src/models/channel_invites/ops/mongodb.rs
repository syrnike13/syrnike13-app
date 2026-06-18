use futures::StreamExt;
use syrnike_result::Result;

use crate::Invite;
use crate::MongoDb;
use bson::{Bson, Document};

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
                "revoked_at": Bson::Null,
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

    async fn increment_invite_uses(&self, code: &str) -> Result<Invite> {
        self.col::<Document>(COL)
            .update_one(
                doc! {
                    "_id": code
                },
                doc! {
                    "$inc": {
                        "uses": 1_i64
                    }
                },
            )
            .await
            .map_err(|_| create_database_error!("update_one", COL))?;

        self.fetch_invite(code).await
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
    async fn mongodb_increment_and_revoke_invite_update_lifecycle_fields() {
        if std::env::var("TEST_DB").as_deref() != Ok("MONGODB") {
            return;
        }

        let db = DatabaseInfo::Test(
            "mongodb_increment_and_revoke_invite_update_lifecycle_fields".to_string(),
        )
        .connect()
        .await
        .expect("database connection");

        if !matches!(db, Database::MongoDb(_)) {
            return;
        }

        db.drop_database().await;
        db.insert_invite(&invite()).await.expect("invite inserted");

        let incremented = db
            .increment_invite_uses("invite-1")
            .await
            .expect("invite incremented");
        match incremented {
            Invite::Server { uses, .. } => assert_eq!(uses, 1),
            _ => unreachable!("expected server invite"),
        }

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

        db.drop_database().await;
    }
}
