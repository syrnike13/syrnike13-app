use syrnike_result::Result;

use crate::{
    ReferenceDb, ServerAuditLogEntry, ServerAuditLogQuery, ServerAuditLogStatus,
    ServerAuditLogTarget,
};

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
                    .action
                    .as_ref()
                    .is_none_or(|action| &entry.action == action)
            })
            .filter(|entry| {
                query
                    .actor_id
                    .as_ref()
                    .is_none_or(|id| &entry.actor_id == id)
            })
            .filter(|entry| {
                query
                    .target_type
                    .as_ref()
                    .is_none_or(|target_type| target_type_matches(&entry.target, target_type))
            })
            .filter(|entry| {
                query
                    .target_id
                    .as_ref()
                    .is_none_or(|target_id| target_id_matches(&entry.target, target_id))
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

fn target_type_matches(target: &ServerAuditLogTarget, target_type: &str) -> bool {
    match target {
        ServerAuditLogTarget::Server { .. } => target_type == "Server",
        ServerAuditLogTarget::Role { .. } => target_type == "Role",
        ServerAuditLogTarget::Member { .. } => target_type == "Member",
        ServerAuditLogTarget::User { .. } => target_type == "User",
        ServerAuditLogTarget::Invite { .. } => target_type == "Invite",
        ServerAuditLogTarget::Channel { .. } => target_type == "Channel",
        ServerAuditLogTarget::Category { .. } => target_type == "Category",
    }
}

fn target_id_matches(target: &ServerAuditLogTarget, target_id: &str) -> bool {
    match target {
        ServerAuditLogTarget::Server { id }
        | ServerAuditLogTarget::Role { id }
        | ServerAuditLogTarget::User { id }
        | ServerAuditLogTarget::Channel { id }
        | ServerAuditLogTarget::Category { id } => id == target_id,
        ServerAuditLogTarget::Member { user_id } => user_id == target_id,
        ServerAuditLogTarget::Invite { code } => code == target_id,
    }
}
