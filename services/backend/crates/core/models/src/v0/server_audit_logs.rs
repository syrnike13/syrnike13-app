use std::collections::HashMap;

auto_derived!(
    /// Server audit log entry.
    pub struct ServerAuditLogEntry {
        #[cfg_attr(feature = "serde", serde(rename = "_id"))]
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
    /// Server audit action.
    #[cfg_attr(feature = "serde", serde(tag = "type"))]
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
    /// Server audit target.
    #[cfg_attr(feature = "serde", serde(tag = "type"))]
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
    /// Server audit change value.
    pub struct ServerAuditLogChange {
        pub before: Option<serde_json::Value>,
        pub after: Option<serde_json::Value>,
    }
);

auto_derived!(
    /// Server audit entry status.
    pub enum ServerAuditLogStatus {
        Pending,
        Succeeded,
        Failed,
    }
);

auto_derived!(
    /// Server audit log page.
    pub struct ServerAuditLogPage {
        pub entries: Vec<ServerAuditLogEntry>,
        pub next_before: Option<String>,
    }
);
