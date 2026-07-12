use bson::Document;
use futures::StreamExt;
use iso8601_timestamp::Timestamp;
use mongodb::options::ReadConcern;
use syrnike_result::Result;

use crate::{FieldsMember, Member, MemberCompositeKey, PartialMember};
use crate::{IntoDocumentPath, MongoDb};

use super::{AbstractServerMembers, ChunkedServerMembersGenerator};

static COL: &str = "server_members";

fn timestamp_bson(timestamp: &Timestamp) -> bson::Bson {
    bson::to_bson(timestamp).expect("Failed to serialize timestamp")
}

#[async_trait]
impl AbstractServerMembers for MongoDb {
    /// Insert a new server member (or use the existing member if one is found)
    async fn insert_or_merge_member(&self, member: &Member) -> Result<Option<Member>> {
        // Restore a pending record in one operation. If cleanup removed it
        // concurrently, the update returns None and we insert a fresh member below.
        let existing = self
            .col::<Member>(COL)
            .find_one_and_update(
                doc! {
                    "_id.server": &member.id.server,
                    "_id.user": &member.id.user,
                    "pending_deletion_at": {"$exists": true},
                },
                doc! {
                    "$set": {
                        "joined_at": timestamp_bson(&member.joined_at),
                        "temporary": member.temporary,
                    },
                    "$unset": {
                        "pending_deletion_at": ""
                    }
                },
            )
            .return_document(mongodb::options::ReturnDocument::After)
            .await
            .map_err(|_| create_database_error!("update_one", COL))?;

        if existing.is_some() {
            return Ok(existing);
        }

        if self.col::<Member>(COL).insert_one(member).await.is_ok() {
            return Ok(None);
        }

        if self
            .fetch_member(&member.id.server, &member.id.user)
            .await
            .is_ok()
        {
            return Err(create_error!(AlreadyInServer));
        }

        Err(create_database_error!("insert_one", COL))
    }

    /// Fetch a server member by their id
    async fn fetch_member(&self, server_id: &str, user_id: &str) -> Result<Member> {
        query!(
            self,
            find_one,
            COL,
            doc! {
                "_id.server": server_id,
                "_id.user": user_id,
                "pending_deletion_at": {"$exists": false}
            }
        )?
        .ok_or_else(|| create_error!(NotFound))
    }

    /// Fetch all members in a server
    async fn fetch_all_members(&self, server_id: &str) -> Result<Vec<Member>> {
        Ok(self
            .col::<Member>(COL)
            .find(doc! {
                "_id.server": server_id,
                "pending_deletion_at": {"$exists": false}
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

    /// Fetch all members in a server as a generator.
    /// Uses config key pushd.mass_mention_chunk_size as the batch size.
    async fn fetch_all_members_chunked(
        &self,
        server_id: &str,
    ) -> Result<ChunkedServerMembersGenerator> {
        let config = syrnike_config::config().await;

        let mut session = self
            .start_session()
            .await
            .map_err(|_| create_database_error!("start_session", COL))?;

        session
            .start_transaction()
            .read_concern(ReadConcern::snapshot())
            .await
            .map_err(|_| create_database_error!("start_transaction", COL))?;

        let cursor = self
            .col::<Member>(COL)
            .find(doc! {
                "_id.server": server_id,
                "pending_deletion_at": {"$exists": false}
            })
            .session(&mut session)
            .batch_size(config.pushd.mass_mention_chunk_size as u32)
            .await
            .map_err(|_| create_database_error!("find", COL))?;

        Ok(ChunkedServerMembersGenerator::new_mongo(session, cursor))
    }

    async fn fetch_all_members_with_roles(
        &self,
        server_id: &str,
        roles: &[String],
    ) -> Result<Vec<Member>> {
        Ok(self
            .col::<Member>(COL)
            .find(doc! {
                "_id.server": server_id,
                "roles": {"$in": roles},
                "pending_deletion_at": {"$exists": false}
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

    async fn fetch_all_members_with_roles_chunked(
        &self,
        server_id: &str,
        roles: &[String],
    ) -> Result<ChunkedServerMembersGenerator> {
        let config = syrnike_config::config().await;

        let mut session = self
            .start_session()
            .await
            .map_err(|_| create_database_error!("start_session", COL))?;

        session
            .start_transaction()
            .read_concern(ReadConcern::snapshot())
            .await
            .map_err(|_| create_database_error!("start_transaction", COL))?;

        let cursor = self
            .col::<Member>(COL)
            .find(doc! {
                "_id.server": server_id,
                "roles": {"$in": roles},
                "pending_deletion_at": {"$exists": false}
            })
            .session(&mut session)
            .batch_size(config.pushd.mass_mention_chunk_size as u32)
            .await
            .map_err(|_| create_database_error!("find", COL))?;

        return Ok(ChunkedServerMembersGenerator::new_mongo(session, cursor));
    }

    /// Fetch all memberships for a user
    async fn fetch_all_memberships(&self, user_id: &str) -> Result<Vec<Member>> {
        Ok(self
            .col::<Member>(COL)
            .find(doc! {
                "_id.user": user_id,
                "pending_deletion_at": {"$exists": false}
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

    /// Fetch multiple members by their ids
    async fn fetch_members(&self, server_id: &str, ids: &[String]) -> Result<Vec<Member>> {
        Ok(self
            .col::<Member>(COL)
            .find(doc! {
                "_id.server": server_id,
                "pending_deletion_at": {"$exists": false},
                "_id.user": {
                    "$in": ids
                }
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

    /// Fetch member count of a server
    async fn fetch_member_count(&self, server_id: &str) -> Result<usize> {
        self.col::<Member>(COL)
            .count_documents(doc! {
                "_id.server": server_id,
                "pending_deletion_at": {"$exists": false}
            })
            .await
            .map(|c| c as usize)
            .map_err(|_| create_database_error!("count_documents", COL))
    }

    /// Fetch server count of a user
    async fn fetch_server_count(&self, user_id: &str) -> Result<usize> {
        self.col::<Member>(COL)
            .count_documents(doc! {
                "_id.user": user_id,
                "pending_deletion_at": {"$exists": false}
            })
            .await
            .map(|c| c as usize)
            .map_err(|_| create_database_error!("count_documents", COL))
    }

    /// Update information for a server member
    async fn update_member(
        &self,
        id: &MemberCompositeKey,
        partial: &PartialMember,
        remove: Vec<FieldsMember>,
    ) -> Result<()> {
        query!(
            self,
            update_one,
            COL,
            doc! {
                "_id.server": &id.server,
                "_id.user": &id.user
            },
            partial,
            remove.iter().map(|x| x as &dyn IntoDocumentPath).collect(),
            None
        )
        .map(|_| ())
    }

    /// Marks a member for deletion.
    /// This will remove the record if the user has no pending actions (eg. timeout),
    /// otherwise will slate the record for deletion by revolt_crond once the actions expire.
    async fn soft_delete_member(&self, id: &MemberCompositeKey) -> Result<()> {
        let member = self.fetch_member(&id.server, &id.user).await?;
        if member.in_timeout() {
            self.col::<Document>(COL)
                .update_one(
                    doc! {
                        "_id.server": &id.server,
                        "_id.user": &id.user,
                    },
                    doc! {
                        "$set": {"pending_deletion_at": timestamp_bson(&member.timeout.unwrap())},
                        "$unset": {
                            "joined_at": "",
                            "avatar": "",
                            "nickname": "",
                            "roles": "",
                            "temporary": ""
                        }
                    },
                )
                .await
                .map(|_| ())
                .map_err(|_| create_database_error!("update_one", COL))
        } else {
            self.force_delete_member(id).await
        }
    }

    /// Delete a server member by their id
    async fn force_delete_member(&self, id: &MemberCompositeKey) -> Result<()> {
        query!(
            self,
            delete_one,
            COL,
            doc! {
                "_id.server": &id.server,
                "_id.user": &id.user
            }
        )
        .map(|_| ())
    }

    async fn remove_dangling_members(&self) -> Result<()> {
        let now = timestamp_bson(&Timestamp::now_utc());

        self.col::<Document>(COL)
            .delete_many(doc! {
                "pending_deletion_at": {"$lt": now}
            })
            .await
            .map(|_| ())
            .map_err(|_| create_database_error!("delete_many", COL))
    }
}

impl IntoDocumentPath for FieldsMember {
    fn as_path(&self) -> Option<&'static str> {
        match self {
            FieldsMember::JoinedAt => Some("joined_at"),
            FieldsMember::Avatar => Some("avatar"),
            FieldsMember::Nickname => Some("nickname"),
            FieldsMember::Roles => Some("roles"),
            FieldsMember::Timeout => Some("timeout"),
            FieldsMember::CanPublish => Some("can_publish"),
            FieldsMember::CanReceive => Some("can_receive"),
            FieldsMember::VoiceChannel => None,
        }
    }
}
