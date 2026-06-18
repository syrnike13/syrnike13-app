use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use syrnike_models::v0;
use syrnike_result::Result;
use ulid::Ulid;

use crate::Database;

auto_derived!(
    /// Server audit log entry stored in database.
    pub struct ServerAuditLogEntry {
        #[serde(rename = "_id")]
        pub id: String,
        pub server_id: String,
        pub actor_id: String,
        pub action: ServerAuditLogAction,
        pub target: ServerAuditLogTarget,
        pub reason: Option<String>,
        pub changes: HashMap<String, ServerAuditLogChange>,
        pub status: ServerAuditLogStatus,
        pub error: Option<String>,
        pub request_id: Option<String>,
        pub created_at: u64,
        pub completed_at: Option<u64>,
    }
);

auto_derived!(
    #[serde(tag = "type")]
    pub enum ServerAuditLogAction {
        ServerUpdate,
        RoleCreate,
        RoleUpdate,
        RoleDelete,
        RoleReorder,
        MemberUpdate,
        MemberKick,
        MemberBan,
        MemberUnban,
        MemberTimeout,
        InviteCreate,
        InviteUpdate,
        InviteRevoke,
        InviteDelete,
        ChannelPermissionUpdate,
        ServerPermissionUpdate,
    }
);

auto_derived!(
    #[serde(tag = "type")]
    pub enum ServerAuditLogTarget {
        Server { id: String },
        Role { id: String },
        Member { user_id: String },
        User { id: String },
        Invite { code: String },
        Channel { id: String },
        Category { id: String },
    }
);

auto_derived!(
    pub struct ServerAuditLogChange {
        pub before: Option<Value>,
        pub after: Option<Value>,
    }
);

auto_derived!(
    pub enum ServerAuditLogStatus {
        Pending,
        Succeeded,
        Failed,
    }
);

#[derive(Clone, Debug, Default)]
pub struct ServerAuditLogQuery {
    pub action: Option<ServerAuditLogAction>,
    pub actor_id: Option<String>,
    pub target_type: Option<String>,
    pub target_id: Option<String>,
    pub before: Option<String>,
    pub limit: usize,
}

pub fn audit_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

impl ServerAuditLogEntry {
    pub fn pending(
        server_id: String,
        actor_id: String,
        action: ServerAuditLogAction,
        target: ServerAuditLogTarget,
        reason: Option<String>,
        changes: HashMap<String, ServerAuditLogChange>,
        request_id: Option<String>,
    ) -> Self {
        Self {
            id: Ulid::new().to_string(),
            server_id,
            actor_id,
            action,
            target,
            reason,
            changes,
            status: ServerAuditLogStatus::Pending,
            error: None,
            request_id,
            created_at: audit_timestamp(),
            completed_at: None,
        }
    }

    pub async fn insert_pending(self, db: &Database) -> Result<Self> {
        db.insert_server_audit_log(&self).await?;
        Ok(self)
    }

    pub async fn mark_succeeded(&mut self, db: &Database) -> Result<()> {
        self.status = ServerAuditLogStatus::Succeeded;
        self.error = None;
        self.completed_at = Some(audit_timestamp());
        db.update_server_audit_log_status(
            &self.id,
            self.status.clone(),
            self.error.clone(),
            self.completed_at,
        )
        .await
    }

    pub async fn mark_failed(&mut self, db: &Database, error: String) -> Result<()> {
        self.status = ServerAuditLogStatus::Failed;
        self.error = Some(error);
        self.completed_at = Some(audit_timestamp());
        db.update_server_audit_log_status(
            &self.id,
            self.status.clone(),
            self.error.clone(),
            self.completed_at,
        )
        .await
    }
}

impl From<ServerAuditLogEntry> for v0::ServerAuditLogEntry {
    fn from(value: ServerAuditLogEntry) -> Self {
        Self {
            id: value.id,
            server_id: value.server_id,
            actor_id: value.actor_id,
            action: value.action.into(),
            target: value.target.into(),
            reason: value.reason,
            changes: value
                .changes
                .into_iter()
                .map(|(key, value)| (key, value.into()))
                .collect(),
            status: value.status.into(),
            error: value.error,
            request_id: value.request_id,
            created_at: value.created_at,
            completed_at: value.completed_at,
        }
    }
}

impl From<ServerAuditLogAction> for v0::ServerAuditLogAction {
    fn from(value: ServerAuditLogAction) -> Self {
        match value {
            ServerAuditLogAction::ServerUpdate => Self::ServerUpdate,
            ServerAuditLogAction::RoleCreate => Self::RoleCreate,
            ServerAuditLogAction::RoleUpdate => Self::RoleUpdate,
            ServerAuditLogAction::RoleDelete => Self::RoleDelete,
            ServerAuditLogAction::RoleReorder => Self::RoleReorder,
            ServerAuditLogAction::MemberUpdate => Self::MemberUpdate,
            ServerAuditLogAction::MemberKick => Self::MemberKick,
            ServerAuditLogAction::MemberBan => Self::MemberBan,
            ServerAuditLogAction::MemberUnban => Self::MemberUnban,
            ServerAuditLogAction::MemberTimeout => Self::MemberTimeout,
            ServerAuditLogAction::InviteCreate => Self::InviteCreate,
            ServerAuditLogAction::InviteUpdate => Self::InviteUpdate,
            ServerAuditLogAction::InviteRevoke => Self::InviteRevoke,
            ServerAuditLogAction::InviteDelete => Self::InviteDelete,
            ServerAuditLogAction::ChannelPermissionUpdate => Self::ChannelPermissionUpdate,
            ServerAuditLogAction::ServerPermissionUpdate => Self::ServerPermissionUpdate,
        }
    }
}

impl From<ServerAuditLogTarget> for v0::ServerAuditLogTarget {
    fn from(value: ServerAuditLogTarget) -> Self {
        match value {
            ServerAuditLogTarget::Server { id } => Self::Server { id },
            ServerAuditLogTarget::Role { id } => Self::Role { id },
            ServerAuditLogTarget::Member { user_id } => Self::Member { user_id },
            ServerAuditLogTarget::User { id } => Self::User { id },
            ServerAuditLogTarget::Invite { code } => Self::Invite { code },
            ServerAuditLogTarget::Channel { id } => Self::Channel { id },
            ServerAuditLogTarget::Category { id } => Self::Category { id },
        }
    }
}

impl From<ServerAuditLogChange> for v0::ServerAuditLogChange {
    fn from(value: ServerAuditLogChange) -> Self {
        Self {
            before: value.before,
            after: value.after,
        }
    }
}

impl From<ServerAuditLogStatus> for v0::ServerAuditLogStatus {
    fn from(value: ServerAuditLogStatus) -> Self {
        match value {
            ServerAuditLogStatus::Pending => Self::Pending,
            ServerAuditLogStatus::Succeeded => Self::Succeeded,
            ServerAuditLogStatus::Failed => Self::Failed,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use crate::{
        Database, ReferenceDb, ServerAuditLogAction, ServerAuditLogEntry, ServerAuditLogQuery,
        ServerAuditLogStatus, ServerAuditLogTarget,
    };

    #[async_std::test]
    async fn reference_audit_log_insert_finalize_and_fetch() {
        let db = Database::Reference(ReferenceDb::default());
        let mut entry = ServerAuditLogEntry::pending(
            "server-1".to_string(),
            "actor-1".to_string(),
            ServerAuditLogAction::RoleCreate,
            ServerAuditLogTarget::Role {
                id: "role-1".to_string(),
            },
            Some("initial setup".to_string()),
            HashMap::new(),
            None,
        )
        .insert_pending(&db)
        .await
        .expect("pending audit inserted");

        entry.mark_succeeded(&db).await.expect("audit finalized");

        let entries = db
            .fetch_server_audit_logs(
                "server-1",
                ServerAuditLogQuery {
                    limit: 50,
                    ..Default::default()
                },
            )
            .await
            .expect("audit entries fetched");

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].status, ServerAuditLogStatus::Succeeded);
        assert_eq!(entries[0].reason.as_deref(), Some("initial setup"));
    }
}
