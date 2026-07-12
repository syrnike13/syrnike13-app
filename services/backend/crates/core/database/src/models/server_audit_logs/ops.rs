use syrnike_result::Result;

use crate::{ServerAuditLogEntry, ServerAuditLogQuery, ServerAuditLogStatus};

#[cfg(feature = "mongodb")]
mod mongodb;
mod reference;

#[async_trait]
pub trait AbstractServerAuditLogs: Sync + Send {
    async fn insert_server_audit_log(&self, entry: &ServerAuditLogEntry) -> Result<()>;

    async fn update_server_audit_log_status(
        &self,
        id: &str,
        status: ServerAuditLogStatus,
        error: Option<String>,
        completed_at: Option<u64>,
    ) -> Result<()>;

    async fn fetch_server_audit_logs(
        &self,
        server_id: &str,
        query: ServerAuditLogQuery,
    ) -> Result<Vec<ServerAuditLogEntry>>;
}
