use syrnike_result::Result;

use crate::{ReferenceDb, ServerAuditLogEntry, ServerAuditLogQuery, ServerAuditLogStatus};

use super::AbstractServerAuditLogs;

#[async_trait]
impl AbstractServerAuditLogs for ReferenceDb {
    async fn insert_server_audit_log(&self, entry: &ServerAuditLogEntry) -> Result<()> {
        let mut entries = self.server_audit_logs.lock().await;
        if entries.contains_key(&entry.id) {
            Err(create_database_error!("insert", "server_audit_logs"))
        } else {
            entries.insert(entry.id.clone(), entry.clone());
            Ok(())
        }
    }

    async fn update_server_audit_log_status(
        &self,
        id: &str,
        status: ServerAuditLogStatus,
        error: Option<String>,
        completed_at: Option<u64>,
    ) -> Result<()> {
        let mut entries = self.server_audit_logs.lock().await;
        let entry = entries.get_mut(id).ok_or_else(|| create_error!(NotFound))?;
        entry.status = status;
        entry.error = error;
        entry.completed_at = completed_at;
        Ok(())
    }

    async fn fetch_server_audit_logs(
        &self,
        server_id: &str,
        query: ServerAuditLogQuery,
    ) -> Result<Vec<ServerAuditLogEntry>> {
        let mut entries = self
            .server_audit_logs
            .lock()
            .await
            .values()
            .filter(|entry| entry.server_id == server_id)
            .filter(|entry| {
                query
                    .actor_id
                    .as_ref()
                    .is_none_or(|id| &entry.actor_id == id)
            })
            .cloned()
            .collect::<Vec<_>>();

        entries.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| b.id.cmp(&a.id))
        });

        if let Some(before) = query.before {
            if let Some(index) = entries.iter().position(|entry| entry.id == before) {
                entries = entries.into_iter().skip(index + 1).collect();
            }
        }

        entries.truncate(query.limit.clamp(1, 100));
        Ok(entries)
    }
}
