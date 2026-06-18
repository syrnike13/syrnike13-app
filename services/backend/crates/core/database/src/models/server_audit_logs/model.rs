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
        ChannelCreate,
        ChannelUpdate,
        ChannelDelete,
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
        let status = ServerAuditLogStatus::Succeeded;
        let error = None;
        let completed_at = Some(audit_timestamp());

        db.update_server_audit_log_status(&self.id, status.clone(), error.clone(), completed_at)
            .await?;

        self.status = status;
        self.error = error;
        self.completed_at = completed_at;
        Ok(())
    }

    pub async fn mark_failed(&mut self, db: &Database, error: String) -> Result<()> {
        let status = ServerAuditLogStatus::Failed;
        let error = Some(error);
        let completed_at = Some(audit_timestamp());

        db.update_server_audit_log_status(&self.id, status.clone(), error.clone(), completed_at)
            .await?;

        self.status = status;
        self.error = error;
        self.completed_at = completed_at;
        Ok(())
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
            ServerAuditLogAction::ChannelCreate => Self::ChannelCreate,
            ServerAuditLogAction::ChannelUpdate => Self::ChannelUpdate,
            ServerAuditLogAction::ChannelDelete => Self::ChannelDelete,
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
    use bson::{doc, to_bson, to_document, Bson};
    use syrnike_result::ErrorType;

    fn audit_entry(
        id: &str,
        created_at: u64,
        action: ServerAuditLogAction,
        target: ServerAuditLogTarget,
    ) -> ServerAuditLogEntry {
        ServerAuditLogEntry {
            id: id.to_string(),
            server_id: "server-1".to_string(),
            actor_id: "actor-1".to_string(),
            action,
            target,
            reason: None,
            changes: HashMap::new(),
            status: ServerAuditLogStatus::Pending,
            error: None,
            request_id: None,
            created_at,
            completed_at: None,
        }
    }

    async fn insert_audit_entry(db: &Database, entry: ServerAuditLogEntry) -> ServerAuditLogEntry {
        db.insert_server_audit_log(&entry)
            .await
            .expect("audit entry inserted");
        entry
    }

    fn ids(entries: Vec<ServerAuditLogEntry>) -> Vec<String> {
        entries.into_iter().map(|entry| entry.id).collect()
    }

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

    #[async_std::test]
    async fn reference_audit_log_filters_by_action() {
        let db = Database::Reference(ReferenceDb::default());
        insert_audit_entry(
            &db,
            audit_entry(
                "01ARZ3NDEKTSV4RRFFQ69G5FAV",
                10,
                ServerAuditLogAction::RoleCreate,
                ServerAuditLogTarget::Role {
                    id: "role-1".to_string(),
                },
            ),
        )
        .await;
        insert_audit_entry(
            &db,
            audit_entry(
                "01ARZ3NDEKTSV4RRFFQ69G5FAW",
                20,
                ServerAuditLogAction::MemberKick,
                ServerAuditLogTarget::User {
                    id: "user-1".to_string(),
                },
            ),
        )
        .await;

        let entries = db
            .fetch_server_audit_logs(
                "server-1",
                ServerAuditLogQuery {
                    action: Some(ServerAuditLogAction::RoleCreate),
                    limit: 50,
                    ..Default::default()
                },
            )
            .await
            .expect("audit entries fetched");

        assert_eq!(ids(entries), vec!["01ARZ3NDEKTSV4RRFFQ69G5FAV"]);
    }

    #[async_std::test]
    async fn reference_audit_log_filters_by_target_type() {
        let db = Database::Reference(ReferenceDb::default());
        insert_audit_entry(
            &db,
            audit_entry(
                "01ARZ3NDEKTSV4RRFFQ69G5FAV",
                10,
                ServerAuditLogAction::RoleCreate,
                ServerAuditLogTarget::Role {
                    id: "role-1".to_string(),
                },
            ),
        )
        .await;
        insert_audit_entry(
            &db,
            audit_entry(
                "01ARZ3NDEKTSV4RRFFQ69G5FAW",
                20,
                ServerAuditLogAction::InviteCreate,
                ServerAuditLogTarget::Invite {
                    code: "invite-1".to_string(),
                },
            ),
        )
        .await;

        let entries = db
            .fetch_server_audit_logs(
                "server-1",
                ServerAuditLogQuery {
                    target_type: Some("Role".to_string()),
                    limit: 50,
                    ..Default::default()
                },
            )
            .await
            .expect("audit entries fetched");

        assert_eq!(ids(entries), vec!["01ARZ3NDEKTSV4RRFFQ69G5FAV"]);
    }

    #[async_std::test]
    async fn reference_audit_log_filters_by_target_id() {
        let db = Database::Reference(ReferenceDb::default());
        insert_audit_entry(
            &db,
            audit_entry(
                "01ARZ3NDEKTSV4RRFFQ69G5FAV",
                10,
                ServerAuditLogAction::RoleCreate,
                ServerAuditLogTarget::Role {
                    id: "role-1".to_string(),
                },
            ),
        )
        .await;
        insert_audit_entry(
            &db,
            audit_entry(
                "01ARZ3NDEKTSV4RRFFQ69G5FAW",
                20,
                ServerAuditLogAction::InviteCreate,
                ServerAuditLogTarget::Invite {
                    code: "role-1".to_string(),
                },
            ),
        )
        .await;
        insert_audit_entry(
            &db,
            audit_entry(
                "01ARZ3NDEKTSV4RRFFQ69G5FAX",
                30,
                ServerAuditLogAction::MemberUpdate,
                ServerAuditLogTarget::Member {
                    user_id: "user-1".to_string(),
                },
            ),
        )
        .await;

        let target_id_entries = db
            .fetch_server_audit_logs(
                "server-1",
                ServerAuditLogQuery {
                    target_id: Some("role-1".to_string()),
                    limit: 50,
                    ..Default::default()
                },
            )
            .await
            .expect("audit entries fetched");
        assert_eq!(
            ids(target_id_entries),
            vec!["01ARZ3NDEKTSV4RRFFQ69G5FAW", "01ARZ3NDEKTSV4RRFFQ69G5FAV"]
        );

        let combined_entries = db
            .fetch_server_audit_logs(
                "server-1",
                ServerAuditLogQuery {
                    target_type: Some("Role".to_string()),
                    target_id: Some("role-1".to_string()),
                    limit: 50,
                    ..Default::default()
                },
            )
            .await
            .expect("audit entries fetched");
        assert_eq!(ids(combined_entries), vec!["01ARZ3NDEKTSV4RRFFQ69G5FAV"]);
    }

    #[async_std::test]
    async fn reference_audit_log_before_cursor_uses_sorted_position() {
        let db = Database::Reference(ReferenceDb::default());
        insert_audit_entry(
            &db,
            audit_entry(
                "01ARZ3NDEKTSV4RRFFQ69G5FAV",
                100,
                ServerAuditLogAction::RoleCreate,
                ServerAuditLogTarget::Role {
                    id: "role-1".to_string(),
                },
            ),
        )
        .await;
        insert_audit_entry(
            &db,
            audit_entry(
                "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
                100,
                ServerAuditLogAction::RoleUpdate,
                ServerAuditLogTarget::Role {
                    id: "role-2".to_string(),
                },
            ),
        )
        .await;
        insert_audit_entry(
            &db,
            audit_entry(
                "01ARZ3NDEKTSV4RRFFQ69G5FAY",
                90,
                ServerAuditLogAction::RoleDelete,
                ServerAuditLogTarget::Role {
                    id: "role-3".to_string(),
                },
            ),
        )
        .await;

        let entries = db
            .fetch_server_audit_logs(
                "server-1",
                ServerAuditLogQuery {
                    before: Some("01ARZ3NDEKTSV4RRFFQ69G5FAZ".to_string()),
                    limit: 50,
                    ..Default::default()
                },
            )
            .await
            .expect("audit entries fetched");

        assert_eq!(
            ids(entries),
            vec!["01ARZ3NDEKTSV4RRFFQ69G5FAV", "01ARZ3NDEKTSV4RRFFQ69G5FAY"]
        );
    }

    #[async_std::test]
    async fn reference_audit_log_missing_or_filtered_before_cursor_returns_empty_page() {
        let db = Database::Reference(ReferenceDb::default());
        insert_audit_entry(
            &db,
            audit_entry(
                "01ARZ3NDEKTSV4RRFFQ69G5FAV",
                100,
                ServerAuditLogAction::RoleCreate,
                ServerAuditLogTarget::Role {
                    id: "role-1".to_string(),
                },
            ),
        )
        .await;
        insert_audit_entry(
            &db,
            audit_entry(
                "01ARZ3NDEKTSV4RRFFQ69G5FAW",
                90,
                ServerAuditLogAction::MemberKick,
                ServerAuditLogTarget::User {
                    id: "user-1".to_string(),
                },
            ),
        )
        .await;

        let missing_cursor = db
            .fetch_server_audit_logs(
                "server-1",
                ServerAuditLogQuery {
                    before: Some("missing-cursor".to_string()),
                    limit: 50,
                    ..Default::default()
                },
            )
            .await
            .expect("audit entries fetched");
        assert!(missing_cursor.is_empty());

        let filtered_out_cursor = db
            .fetch_server_audit_logs(
                "server-1",
                ServerAuditLogQuery {
                    action: Some(ServerAuditLogAction::RoleCreate),
                    before: Some("01ARZ3NDEKTSV4RRFFQ69G5FAW".to_string()),
                    limit: 50,
                    ..Default::default()
                },
            )
            .await
            .expect("audit entries fetched");
        assert!(filtered_out_cursor.is_empty());
    }

    #[async_std::test]
    async fn reference_audit_log_limit_is_clamped() {
        let db = Database::Reference(ReferenceDb::default());
        for index in 0..101 {
            insert_audit_entry(
                &db,
                audit_entry(
                    &format!("audit-{index:03}"),
                    index,
                    ServerAuditLogAction::RoleCreate,
                    ServerAuditLogTarget::Role {
                        id: format!("role-{index}"),
                    },
                ),
            )
            .await;
        }

        let zero_limit = db
            .fetch_server_audit_logs(
                "server-1",
                ServerAuditLogQuery {
                    limit: 0,
                    ..Default::default()
                },
            )
            .await
            .expect("audit entries fetched");
        assert_eq!(zero_limit.len(), 1);

        let large_limit = db
            .fetch_server_audit_logs(
                "server-1",
                ServerAuditLogQuery {
                    limit: 500,
                    ..Default::default()
                },
            )
            .await
            .expect("audit entries fetched");
        assert_eq!(large_limit.len(), 100);
    }

    #[async_std::test]
    async fn reference_audit_log_missing_finalize_returns_not_found_without_mutating_entry() {
        let db = Database::Reference(ReferenceDb::default());
        let mut entry = audit_entry(
            "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            10,
            ServerAuditLogAction::RoleCreate,
            ServerAuditLogTarget::Role {
                id: "role-1".to_string(),
            },
        );

        let error = entry
            .mark_succeeded(&db)
            .await
            .expect_err("missing audit entry returns error");

        assert!(matches!(error.error_type, ErrorType::NotFound));
        assert_eq!(entry.status, ServerAuditLogStatus::Pending);
        assert_eq!(entry.error, None);
        assert_eq!(entry.completed_at, None);
    }

    #[async_std::test]
    async fn reference_audit_log_mark_failed_stores_failure_details() {
        let db = Database::Reference(ReferenceDb::default());
        let mut entry = insert_audit_entry(
            &db,
            audit_entry(
                "01ARZ3NDEKTSV4RRFFQ69G5FAV",
                10,
                ServerAuditLogAction::RoleCreate,
                ServerAuditLogTarget::Role {
                    id: "role-1".to_string(),
                },
            ),
        )
        .await;

        entry
            .mark_failed(&db, "role name already exists".to_string())
            .await
            .expect("audit failed");

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

        assert_eq!(entries[0].status, ServerAuditLogStatus::Failed);
        assert_eq!(
            entries[0].error.as_deref(),
            Some("role name already exists")
        );
        assert_eq!(entry.status, ServerAuditLogStatus::Failed);
        assert_eq!(entry.error.as_deref(), Some("role name already exists"));
    }

    #[test]
    fn mongo_audit_log_filters_use_expected_bson_shape() {
        let action = to_bson(&ServerAuditLogAction::RoleCreate).expect("action serializes");
        let target = to_document(&ServerAuditLogTarget::Member {
            user_id: "user-1".to_string(),
        })
        .expect("target serializes");

        assert_eq!(action, Bson::Document(doc! { "type": "RoleCreate" }));
        assert_eq!(
            target,
            doc! {
                "type": "Member",
                "user_id": "user-1"
            }
        );
    }
}
