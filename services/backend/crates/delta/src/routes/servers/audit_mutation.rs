use std::collections::HashMap;

use serde::Serialize;
use syrnike_database::{
    Database, ServerAuditLogAction, ServerAuditLogChange, ServerAuditLogEntry, ServerAuditLogTarget,
};
use syrnike_result::{Error, Result, ToSyrnikeError};

pub fn audit_change<T: Serialize>(
    before: Option<T>,
    after: Option<T>,
) -> Result<ServerAuditLogChange> {
    Ok(ServerAuditLogChange {
        before: before
            .map(serde_json::to_value)
            .transpose()
            .to_internal_error()?,
        after: after
            .map(serde_json::to_value)
            .transpose()
            .to_internal_error()?,
    })
}

pub fn audit_changes(
    entries: Vec<(&'static str, ServerAuditLogChange)>,
) -> HashMap<String, ServerAuditLogChange> {
    entries
        .into_iter()
        .map(|(key, value)| (key.to_string(), value))
        .collect()
}

pub async fn insert_pending_audit(
    db: &Database,
    server_id: String,
    actor_id: String,
    action: ServerAuditLogAction,
    target: ServerAuditLogTarget,
    reason: Option<String>,
    changes: HashMap<String, ServerAuditLogChange>,
) -> Result<ServerAuditLogEntry> {
    ServerAuditLogEntry::pending(server_id, actor_id, action, target, reason, changes, None)
        .insert_pending(db)
        .await
}

pub async fn mark_failed_and_return<T>(
    db: &Database,
    audit: &mut ServerAuditLogEntry,
    error: Error,
) -> Result<T> {
    audit.mark_failed(db, error.to_string()).await?;
    Err(error)
}
