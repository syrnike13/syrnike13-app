use bson::{Bson, Document};
use futures::TryStreamExt;
use syrnike_result::Result;

use crate::{MongoDb, ServerAuditLogEntry, ServerAuditLogQuery, ServerAuditLogStatus};

use super::AbstractServerAuditLogs;

static COL: &str = "server_audit_logs";

#[async_trait]
impl AbstractServerAuditLogs for MongoDb {
    async fn insert_server_audit_log(&self, entry: &ServerAuditLogEntry) -> Result<()> {
        query!(self, insert_one, COL, entry).map(|_| ())
    }

    async fn update_server_audit_log_status(
        &self,
        id: &str,
        status: ServerAuditLogStatus,
        error: Option<String>,
        completed_at: Option<u64>,
    ) -> Result<()> {
        let status =
            bson::to_bson(&status).map_err(|_| create_database_error!("serialize", COL))?;
        let mut set = doc! { "status": status };
        set.insert("error", error.map(Bson::String).unwrap_or(Bson::Null));
        set.insert(
            "completed_at",
            completed_at
                .map(|value| Bson::Int64(value as i64))
                .unwrap_or(Bson::Null),
        );

        let result = self
            .col::<Document>(COL)
            .update_one(doc! { "_id": id }, doc! { "$set": set })
            .await
            .map_err(|_| create_database_error!("update_one", COL))?;

        if result.matched_count == 0 {
            Err(create_error!(NotFound))
        } else {
            Ok(())
        }
    }

    async fn fetch_server_audit_logs(
        &self,
        server_id: &str,
        query: ServerAuditLogQuery,
    ) -> Result<Vec<ServerAuditLogEntry>> {
        let before = query.before.clone();
        let limit = query.limit.clamp(1, 100) as i64;
        let mut filter = query_filter(server_id, query)?;

        if let Some(before_id) = before {
            let mut before_filter = filter.clone();
            before_filter.insert("_id", before_id);

            let before_entry = self
                .col::<ServerAuditLogEntry>(COL)
                .find_one(before_filter)
                .await
                .map_err(|_| create_database_error!("find_one", COL))?;

            let Some(before_entry) = before_entry else {
                return Ok(Vec::new());
            };

            filter = doc! {
                "$and": [
                    filter,
                    {
                        "$or": [
                            { "created_at": { "$lt": before_entry.created_at as i64 } },
                            {
                                "created_at": before_entry.created_at as i64,
                                "_id": { "$lt": before_entry.id }
                            }
                        ]
                    }
                ]
            };
        }

        self.col::<ServerAuditLogEntry>(COL)
            .find(filter)
            .sort(doc! { "created_at": -1_i32, "_id": -1_i32 })
            .limit(limit)
            .await
            .map_err(|_| create_database_error!("find", COL))?
            .try_collect()
            .await
            .map_err(|_| create_database_error!("collect", COL))
    }
}

fn query_filter(server_id: &str, query: ServerAuditLogQuery) -> Result<Document> {
    let mut filters = vec![doc! { "server_id": server_id }];

    if let Some(action) = query.action {
        filters.push(doc! {
            "action": bson::to_bson(&action)
                .map_err(|_| create_database_error!("serialize", COL))?
        });
    }

    if let Some(actor_id) = query.actor_id {
        filters.push(doc! { "actor_id": actor_id });
    }

    match (query.target_type, query.target_id) {
        (Some(target_type), Some(target_id)) => {
            filters.push(doc! { "target.type": &target_type });
            filters.push(target_id_filter_for_type(&target_type, target_id));
        }
        (Some(target_type), None) => {
            filters.push(doc! { "target.type": target_type });
        }
        (None, Some(target_id)) => {
            filters.push(doc! {
                "$or": [
                    { "target.id": &target_id },
                    { "target.user_id": &target_id },
                    { "target.code": target_id },
                ]
            });
        }
        (None, None) => {}
    }

    Ok(match filters.as_slice() {
        [filter] => filter.clone(),
        _ => doc! { "$and": filters },
    })
}

fn target_id_filter_for_type(target_type: &str, target_id: String) -> Document {
    match target_type {
        "Member" => doc! { "target.user_id": target_id },
        "Invite" => doc! { "target.code": target_id },
        "Server" | "Role" | "User" | "Channel" | "Category" => {
            doc! { "target.id": target_id }
        }
        _ => doc! { "target.__unknown": target_id },
    }
}

#[cfg(test)]
mod tests {
    use bson::{doc, to_bson};

    use crate::{ServerAuditLogAction, ServerAuditLogQuery};

    use super::{query_filter, target_id_filter_for_type};

    #[test]
    fn query_filter_uses_audit_log_bson_paths() {
        let filter = query_filter(
            "server-1",
            ServerAuditLogQuery {
                action: Some(ServerAuditLogAction::RoleCreate),
                target_type: Some("Member".to_string()),
                target_id: Some("user-1".to_string()),
                limit: 50,
                ..Default::default()
            },
        )
        .expect("filter built");

        assert_eq!(
            filter,
            doc! {
                "$and": [
                    { "server_id": "server-1" },
                    {
                        "action": to_bson(&ServerAuditLogAction::RoleCreate)
                            .expect("action serializes")
                    },
                    { "target.type": "Member" },
                    { "target.user_id": "user-1" },
                ]
            }
        );
    }

    #[test]
    fn target_id_filter_uses_variant_specific_bson_paths() {
        assert_eq!(
            target_id_filter_for_type("Role", "role-1".to_string()),
            doc! { "target.id": "role-1" }
        );
        assert_eq!(
            target_id_filter_for_type("Invite", "invite-1".to_string()),
            doc! { "target.code": "invite-1" }
        );
        assert_eq!(
            target_id_filter_for_type("Member", "user-1".to_string()),
            doc! { "target.user_id": "user-1" }
        );
    }
}
