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

        self.col::<Document>(COL)
            .update_one(doc! { "_id": id }, doc! { "$set": set })
            .await
            .map(|_| ())
            .map_err(|_| create_database_error!("update_one", COL))
    }

    async fn fetch_server_audit_logs(
        &self,
        server_id: &str,
        query: ServerAuditLogQuery,
    ) -> Result<Vec<ServerAuditLogEntry>> {
        let mut filter = doc! { "server_id": server_id };
        if let Some(actor_id) = query.actor_id {
            filter.insert("actor_id", actor_id);
        }
        if let Some(before) = query.before {
            filter.insert("_id", doc! { "$lt": before });
        }

        self.col::<ServerAuditLogEntry>(COL)
            .find(filter)
            .sort(doc! { "created_at": -1_i32, "_id": -1_i32 })
            .limit(query.limit.clamp(1, 100) as i64)
            .await
            .map_err(|_| create_database_error!("find", COL))?
            .try_collect()
            .await
            .map_err(|_| create_database_error!("collect", COL))
    }
}
