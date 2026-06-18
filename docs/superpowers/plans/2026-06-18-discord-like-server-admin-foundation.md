# Discord-Like Server Admin Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first Discord-like server administration foundation: mandatory audit logs, correct settings permission entry points, realtime permission consistency fixes, invite lifecycle, and moderation audit coverage.

**Architecture:** Add a backend audit-log domain that follows the existing database trait pattern, then wire admin mutations through explicit audit writes before expanding UI. Fix permission and realtime correctness before adding visible server settings pages, so the UI reflects actual backend behavior instead of masking permission drift.

**Tech Stack:** Rust/Rocket backend, MongoDB/reference database abstraction, Revolt OpenAPI generation, React/TanStack Router/TanStack Query frontend, Vitest, pnpm.

---

## Execution Rules

- Work from `codex/roles`.
- The current checkout has unrelated dirty files in chat/media/package areas. Stage exact paths only.
- Do not edit `node_modules`.
- Do not add backwards compatibility wrappers for old invite or server-admin payloads.
- Do not add UI stubs for AutoMod, onboarding/community, integrations marketplace, forum channels, stage channels, or thread channels.
- For code execution, use a clean worktree before implementation if the current dirty worktree remains dirty.

## File Structure

Backend audit model and storage:

- Create `services/backend/crates/core/models/src/v0/server_audit_logs.rs`.
- Modify `services/backend/crates/core/models/src/v0/mod.rs`.
- Create `services/backend/crates/core/database/src/models/server_audit_logs/model.rs`.
- Create `services/backend/crates/core/database/src/models/server_audit_logs/ops.rs`.
- Create `services/backend/crates/core/database/src/models/server_audit_logs/ops/reference.rs`.
- Create `services/backend/crates/core/database/src/models/server_audit_logs/ops/mongodb.rs`.
- Create `services/backend/crates/core/database/src/models/server_audit_logs/mod.rs`.
- Modify `services/backend/crates/core/database/src/models/mod.rs`.
- Modify `services/backend/crates/core/database/src/drivers/reference.rs`.
- Modify `services/backend/crates/core/database/src/models/admin_migrations/ops/mongodb/scripts.rs`.

Backend routes and audited mutations:

- Create `services/backend/crates/delta/src/routes/servers/audit_log.rs`.
- Create `services/backend/crates/delta/src/routes/servers/audit_mutation.rs`.
- Modify `services/backend/crates/delta/src/routes/servers/mod.rs`.
- Modify `services/backend/crates/delta/src/routes/mod.rs`.
- Modify `services/backend/crates/delta/src/routes/servers/server_edit.rs`.
- Modify `services/backend/crates/delta/src/routes/servers/roles_create.rs`.
- Modify `services/backend/crates/delta/src/routes/servers/roles_edit.rs`.
- Modify `services/backend/crates/delta/src/routes/servers/roles_delete.rs`.
- Modify `services/backend/crates/delta/src/routes/servers/roles_edit_positions.rs`.
- Modify `services/backend/crates/delta/src/routes/servers/permissions_set.rs`.
- Modify `services/backend/crates/delta/src/routes/servers/permissions_set_default.rs`.
- Modify `services/backend/crates/delta/src/routes/servers/member_edit.rs`.
- Modify `services/backend/crates/delta/src/routes/servers/member_remove.rs`.
- Modify `services/backend/crates/delta/src/routes/servers/ban_create.rs`.
- Modify `services/backend/crates/delta/src/routes/servers/ban_remove.rs`.

Realtime and security fixes:

- Modify `services/backend/crates/core/database/src/models/servers/ops/mongodb.rs`.
- Modify `services/backend/crates/bonfire/src/events/impl.rs`.
- Modify `services/backend/crates/daemons/pushd/src/consumers/inbound/mass_mention.rs`.
- Modify `apps/web/src/features/sync/sync-store.ts`.
- Add or modify colocated tests for these modules.

Invite lifecycle:

- Modify `services/backend/crates/core/database/src/models/channel_invites/model.rs`.
- Modify `services/backend/crates/core/database/src/models/channel_invites/ops.rs`.
- Modify `services/backend/crates/core/database/src/models/channel_invites/ops/reference.rs`.
- Modify `services/backend/crates/core/database/src/models/channel_invites/ops/mongodb.rs`.
- Modify `services/backend/crates/core/models/src/v0/invites.rs`.
- Modify `services/backend/crates/delta/src/routes/channels/invite_create.rs`.
- Modify `services/backend/crates/delta/src/routes/servers/invites_fetch.rs`.
- Modify `services/backend/crates/delta/src/routes/invites/invite_join.rs`.
- Modify `services/backend/crates/delta/src/routes/invites/invite_delete.rs`.

Frontend API and settings UI:

- Modify `packages/api-types/src/schema.ts`, `packages/api-types/src/types.ts`, and `packages/api-types/OpenAPI.json` through `pnpm api-types:generate`.
- Modify `apps/web/src/lib/permissions.ts`.
- Modify `apps/web/src/lib/permissions.test.ts`.
- Modify `apps/web/src/components/servers/server-settings-types.ts`.
- Modify `apps/web/src/components/servers/server-settings-page.tsx`.
- Modify `apps/web/src/components/servers/server-settings-panels.tsx`.
- Modify `apps/web/src/features/api/invites-api.ts`.
- Modify `apps/web/src/features/api/servers-api.ts`.
- Add `apps/web/src/components/servers/server-settings-audit-panel.tsx`.
- Add `apps/web/src/components/servers/server-settings-invites-panel.tsx`.
- Add `apps/web/src/components/servers/server-settings-bans-panel.tsx`.

---

### Task 1: Add Server Audit Log API And Database Domain

**Files:**
- Create: `services/backend/crates/core/models/src/v0/server_audit_logs.rs`
- Modify: `services/backend/crates/core/models/src/v0/mod.rs`
- Create: `services/backend/crates/core/database/src/models/server_audit_logs/mod.rs`
- Create: `services/backend/crates/core/database/src/models/server_audit_logs/model.rs`
- Create: `services/backend/crates/core/database/src/models/server_audit_logs/ops.rs`
- Create: `services/backend/crates/core/database/src/models/server_audit_logs/ops/reference.rs`
- Create: `services/backend/crates/core/database/src/models/server_audit_logs/ops/mongodb.rs`
- Modify: `services/backend/crates/core/database/src/models/mod.rs`
- Modify: `services/backend/crates/core/database/src/drivers/reference.rs`
- Test: `services/backend/crates/core/database/src/models/server_audit_logs/model.rs`

- [ ] **Step 1: Create public v0 audit types**

Add `services/backend/crates/core/models/src/v0/server_audit_logs.rs`:

```rust
use std::collections::HashMap;

auto_derived!(
    /// Server audit log entry.
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
    /// Server audit action.
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
    /// Server audit target.
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
```

- [ ] **Step 2: Export public v0 audit types**

Modify `services/backend/crates/core/models/src/v0/mod.rs`:

```rust
mod server_audit_logs;
pub use server_audit_logs::*;
```

Place it beside other v0 model modules.

- [ ] **Step 3: Create database model types**

Add `services/backend/crates/core/database/src/models/server_audit_logs/model.rs`:

```rust
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
```

Add conversion impls for `ServerAuditLogAction`, `ServerAuditLogTarget`, `ServerAuditLogChange`, and `ServerAuditLogStatus` in the same file. Use one-to-one enum matches with no fallback arm.

- [ ] **Step 4: Add database operations trait**

Add `services/backend/crates/core/database/src/models/server_audit_logs/ops.rs`:

```rust
use syrnike_result::Result;

use crate::{
    ServerAuditLogEntry, ServerAuditLogQuery, ServerAuditLogStatus,
};

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
```

- [ ] **Step 5: Add `mod.rs` for the audit model**

Add `services/backend/crates/core/database/src/models/server_audit_logs/mod.rs`:

```rust
mod model;
mod ops;

pub use model::*;
pub use ops::*;
```

- [ ] **Step 6: Implement reference storage**

Modify `services/backend/crates/core/database/src/drivers/reference.rs` imports:

```rust
use crate::{
    Badge, Bot, Channel, ChannelCompositeKey, ChannelUnread, Emoji, File, FileHash, Invite, Member,
    MemberCompositeKey, Message, PolicyChange, RatelimitEvent, Report, Server,
    ServerAuditLogEntry, ServerBan, Snapshot, User, UserBadgeAssignment, UserSettings, Webhook,
};
```

Add a field to `ReferenceDb`:

```rust
pub server_audit_logs: Arc<Mutex<HashMap<String, ServerAuditLogEntry>>>,
```

Add `services/backend/crates/core/database/src/models/server_audit_logs/ops/reference.rs`:

```rust
use syrnike_result::Result;

use crate::{
    ReferenceDb, ServerAuditLogEntry, ServerAuditLogQuery, ServerAuditLogStatus,
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
            .filter(|entry| query.actor_id.as_ref().is_none_or(|id| &entry.actor_id == id))
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
```

- [ ] **Step 7: Implement MongoDB storage**

Add `services/backend/crates/core/database/src/models/server_audit_logs/ops/mongodb.rs`:

```rust
use syrnike_result::Result;

use crate::{
    MongoDb, ServerAuditLogEntry, ServerAuditLogQuery, ServerAuditLogStatus,
};

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
        query!(
            self,
            update_one,
            COL,
            doc! { "_id": id },
            doc! {
                "$set": {
                    "status": status,
                    "error": error,
                    "completed_at": completed_at,
                }
            }
        )
        .map(|_| ())
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
```

Add `use futures::TryStreamExt;` if this file needs it for `try_collect()`.

- [ ] **Step 8: Wire database modules**

Modify `services/backend/crates/core/database/src/models/mod.rs`:

```rust
mod server_audit_logs;
pub use server_audit_logs::*;
```

Add the trait to `AbstractDatabase`:

```rust
+ server_audit_logs::AbstractServerAuditLogs
```

- [ ] **Step 9: Write database tests**

Append tests to `services/backend/crates/core/database/src/models/server_audit_logs/model.rs`:

```rust
#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use crate::{
        Database, ReferenceDb, ServerAuditLogAction, ServerAuditLogEntry,
        ServerAuditLogQuery, ServerAuditLogStatus, ServerAuditLogTarget,
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
```

- [ ] **Step 10: Run database tests**

Run:

```sh
cargo test --manifest-path services/backend/Cargo.toml -p syrnike-database server_audit_logs
```

Expected before all code compiles: first run may fail on missing imports while wiring. Expected after this task: `test result: ok`.

- [ ] **Step 11: Commit**

```sh
git add services/backend/crates/core/models/src/v0/server_audit_logs.rs services/backend/crates/core/models/src/v0/mod.rs services/backend/crates/core/database/src/models/server_audit_logs services/backend/crates/core/database/src/models/mod.rs services/backend/crates/core/database/src/drivers/reference.rs
git commit -m "feat: add server audit log storage"
```

---

### Task 2: Add Mongo Migration And Audit Log Read Route

**Files:**
- Modify: `services/backend/crates/core/database/src/models/admin_migrations/ops/mongodb/scripts.rs`
- Create: `services/backend/crates/delta/src/routes/servers/audit_log.rs`
- Modify: `services/backend/crates/delta/src/routes/servers/mod.rs`
- Modify: `services/backend/crates/delta/src/routes/mod.rs`
- Test: `services/backend/crates/delta/src/routes/servers/audit_log.rs`

- [ ] **Step 1: Add Mongo migration 51**

Modify `services/backend/crates/core/database/src/models/admin_migrations/ops/mongodb/scripts.rs`:

```rust
pub const LATEST_REVISION: i32 = 52; // MUST BE +1 to last migration
```

Add before the final reminder:

```rust
if revision <= 51 {
    info!("Running migration [revision 51 / 18-06-2026]: Add server audit logs.");

    db.db().create_collection("server_audit_logs").await.ok();

    db.db()
        .run_command(doc! {
            "createIndexes": "server_audit_logs",
            "indexes": [
                {
                    "key": {
                        "server_id": 1_i32,
                        "created_at": -1_i32,
                        "_id": -1_i32
                    },
                    "name": "server_created_id"
                },
                {
                    "key": {
                        "server_id": 1_i32,
                        "actor_id": 1_i32,
                        "created_at": -1_i32
                    },
                    "name": "server_actor_created"
                }
            ]
        })
        .await
        .expect("Failed to create server audit log indexes.");
}
```

- [ ] **Step 2: Add audit log route**

Create `services/backend/crates/delta/src/routes/servers/audit_log.rs`:

```rust
use rocket::serde::json::Json;
use rocket::State;
use syrnike_database::{
    util::{permissions::DatabasePermissionQuery, reference::Reference},
    Database, ServerAuditLogQuery, User,
};
use syrnike_models::v0;
use syrnike_permissions::{calculate_server_permissions, ChannelPermission};
use syrnike_result::Result;

#[openapi(tag = "Server Audit Log")]
#[get("/<server>/audit-log?<actor>&<before>&<limit>")]
pub async fn audit_log(
    db: &State<Database>,
    user: User,
    server: Reference<'_>,
    actor: Option<String>,
    before: Option<String>,
    limit: Option<usize>,
) -> Result<Json<v0::ServerAuditLogPage>> {
    let server = server.as_server(db).await?;
    let mut permission_query = DatabasePermissionQuery::new(db, &user).server(&server);
    calculate_server_permissions(&mut permission_query)
        .await
        .throw_if_lacking_channel_permission(ChannelPermission::ManageServer)?;

    let entries = db
        .fetch_server_audit_logs(
            &server.id,
            ServerAuditLogQuery {
                actor_id: actor,
                before,
                limit: limit.unwrap_or(50).clamp(1, 100),
                ..Default::default()
            },
        )
        .await?;

    let next_before = entries.last().map(|entry| entry.id.clone());

    Ok(Json(v0::ServerAuditLogPage {
        entries: entries.into_iter().map(Into::into).collect(),
        next_before,
    }))
}
```

- [ ] **Step 3: Register route and OpenAPI tag**

Modify `services/backend/crates/delta/src/routes/servers/mod.rs`:

```rust
mod audit_log;
```

Add `audit_log::audit_log` to `openapi_get_routes_spec!`.

Modify `services/backend/crates/delta/src/routes/mod.rs` server tag group:

```rust
"Server Audit Log"
```

- [ ] **Step 4: Add route tests**

Append to `services/backend/crates/delta/src/routes/servers/audit_log.rs`:

```rust
#[cfg(test)]
mod tests {
    use rocket::http::Status;
    use serde_json::json;
    use syrnike_database::{
        ServerAuditLogAction, ServerAuditLogEntry, ServerAuditLogTarget,
    };

    use crate::test::TestHarness;

    #[async_std::test]
    async fn audit_log_requires_manage_server() {
        let harness = TestHarness::new().await;
        let (owner, server) = harness.create_user_and_server().await;
        let member = harness.create_user().await;
        harness.join_server(&member, &server).await;

        let response = harness
            .client
            .get(format!("/servers/{}/audit-log", server.id))
            .header(harness.auth_header(&member))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::Forbidden);

        let response = harness
            .client
            .get(format!("/servers/{}/audit-log", server.id))
            .header(harness.auth_header(&owner))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::Ok);
    }

    #[async_std::test]
    async fn audit_log_returns_entries_newest_first() {
        let harness = TestHarness::new().await;
        let (owner, server) = harness.create_user_and_server().await;

        ServerAuditLogEntry::pending(
            server.id.clone(),
            owner.id.clone(),
            ServerAuditLogAction::RoleCreate,
            ServerAuditLogTarget::Role {
                id: "role-1".to_string(),
            },
            None,
            Default::default(),
            None,
        )
        .insert_pending(&harness.db)
        .await
        .expect("audit inserted");

        let response = harness
            .client
            .get(format!("/servers/{}/audit-log", server.id))
            .header(harness.auth_header(&owner))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::Ok);
        let body = response.into_string().await.expect("response body");
        assert!(body.contains("\"entries\""));
        assert!(body.contains("RoleCreate"));
    }
}
```

Adjust helper names only if the local test harness exposes different names. Keep the test intent and route unchanged.

- [ ] **Step 5: Run route tests**

Run:

```sh
cargo test --manifest-path services/backend/Cargo.toml -p syrnike-delta audit_log
```

Expected after this task: audit log route tests pass.

- [ ] **Step 6: Commit**

```sh
git add services/backend/crates/core/database/src/models/admin_migrations/ops/mongodb/scripts.rs services/backend/crates/delta/src/routes/servers/audit_log.rs services/backend/crates/delta/src/routes/servers/mod.rs services/backend/crates/delta/src/routes/mod.rs
git commit -m "feat: expose server audit log route"
```

---

### Task 3: Add Mandatory Audit Mutation Helper And Cover Role Mutations

**Files:**
- Create: `services/backend/crates/delta/src/routes/servers/audit_mutation.rs`
- Modify: `services/backend/crates/delta/src/routes/servers/mod.rs`
- Modify: `services/backend/crates/delta/src/routes/servers/roles_create.rs`
- Modify: `services/backend/crates/delta/src/routes/servers/roles_edit.rs`
- Modify: `services/backend/crates/delta/src/routes/servers/roles_delete.rs`
- Modify: `services/backend/crates/delta/src/routes/servers/roles_edit_positions.rs`
- Modify: `services/backend/crates/delta/src/routes/servers/permissions_set.rs`
- Modify: `services/backend/crates/delta/src/routes/servers/permissions_set_default.rs`
- Test: role route files above

- [ ] **Step 1: Create audit mutation helper**

Add `services/backend/crates/delta/src/routes/servers/audit_mutation.rs`:

```rust
use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;
use syrnike_database::{
    Database, ServerAuditLogAction, ServerAuditLogChange, ServerAuditLogEntry,
    ServerAuditLogTarget,
};
use syrnike_result::Result;

pub fn audit_change<T: Serialize>(before: Option<T>, after: Option<T>) -> ServerAuditLogChange {
    ServerAuditLogChange {
        before: before.and_then(|value| serde_json::to_value(value).ok()),
        after: after.and_then(|value| serde_json::to_value(value).ok()),
    }
}

pub fn audit_changes(entries: Vec<(&'static str, ServerAuditLogChange)>) -> HashMap<String, ServerAuditLogChange> {
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
    ServerAuditLogEntry::pending(
        server_id,
        actor_id,
        action,
        target,
        reason,
        changes,
        None,
    )
    .insert_pending(db)
    .await
}

pub fn json_change(before: Option<Value>, after: Option<Value>) -> ServerAuditLogChange {
    ServerAuditLogChange { before, after }
}
```

This is a real policy helper, not a wrapper for style: every audited route uses it so audit behavior stays mandatory and identical.

- [ ] **Step 2: Wire helper module**

Modify `services/backend/crates/delta/src/routes/servers/mod.rs`:

```rust
mod audit_mutation;
```

- [ ] **Step 3: Audit role creation**

Modify `services/backend/crates/delta/src/routes/servers/roles_create.rs`.

After permission checks and before `Role::create`, insert pending audit:

```rust
let mut audit = audit_mutation::insert_pending_audit(
    db,
    server.id.clone(),
    user.id.clone(),
    ServerAuditLogAction::RoleCreate,
    ServerAuditLogTarget::Server {
        id: server.id.clone(),
    },
    None,
    audit_mutation::audit_changes(vec![(
        "name",
        audit_mutation::audit_change::<String>(None, Some(data.name.clone())),
    )]),
)
.await?;
```

After `Role::create` succeeds:

```rust
audit.mark_succeeded(db).await?;
```

If route code has intermediate fallible operations after pending audit insertion, wrap them:

```rust
let role = match Role::create(db, &server, data.name).await {
    Ok(role) => role,
    Err(error) => {
        let _ = audit.mark_failed(db, error.to_string()).await;
        return Err(error);
    }
};
audit.mark_succeeded(db).await?;
```

- [ ] **Step 4: Audit role edits**

Modify `services/backend/crates/delta/src/routes/servers/roles_edit.rs`.

Create changes from the fetched role before mutation:

```rust
let changes = audit_mutation::audit_changes(vec![
    ("name", audit_mutation::audit_change(role.name.clone().into(), data.name.clone())),
    ("permissions", audit_mutation::audit_change(Some(role.permissions), data.permissions)),
    ("colour", audit_mutation::audit_change(role.colour.clone(), data.colour.clone())),
    ("hoist", audit_mutation::audit_change(Some(role.hoist), data.hoist)),
    ("mentionable", audit_mutation::audit_change(Some(role.mentionable), data.mentionable)),
]);
```

Insert audit with:

```rust
ServerAuditLogAction::RoleUpdate
ServerAuditLogTarget::Role { id: role.id.clone() }
```

Mark failed on `role.update(db, server_id, partial, remove)` error and mark succeeded after the update commits.

- [ ] **Step 5: Audit role deletion**

Modify `services/backend/crates/delta/src/routes/servers/roles_delete.rs`.

Use:

```rust
ServerAuditLogAction::RoleDelete
ServerAuditLogTarget::Role { id: role.id.clone() }
```

Changes:

```rust
audit_mutation::audit_changes(vec![(
    "role",
    audit_mutation::audit_change(Some(role.clone()), None::<syrnike_database::Role>),
)])
```

Insert audit before `role.delete(db, &server.id)`, mark failed on error, mark succeeded after deletion succeeds.

- [ ] **Step 6: Audit role rank reorder**

Modify `services/backend/crates/delta/src/routes/servers/roles_edit_positions.rs`.

Use:

```rust
ServerAuditLogAction::RoleReorder
ServerAuditLogTarget::Server { id: server.id.clone() }
```

Changes:

```rust
let before_order = server
    .roles
    .values()
    .map(|role| (role.id.clone(), role.rank))
    .collect::<Vec<_>>();
let after_order = data.ranks
    .iter()
    .enumerate()
    .map(|(rank, id)| (id.clone(), rank as i64))
    .collect::<Vec<_>>();
let changes = audit_mutation::audit_changes(vec![(
    "ranks",
    audit_mutation::audit_change(Some(before_order), Some(after_order)),
)]);
```

- [ ] **Step 7: Audit permission routes**

Modify `services/backend/crates/delta/src/routes/servers/permissions_set.rs` and `permissions_set_default.rs`.

For role permission overwrite:

```rust
ServerAuditLogAction::ChannelPermissionUpdate
ServerAuditLogTarget::Role { id: role_id.to_string() }
```

For server default permissions:

```rust
ServerAuditLogAction::ServerPermissionUpdate
ServerAuditLogTarget::Server { id: server.id.clone() }
```

Mark success only after the permission update returns success.

- [ ] **Step 8: Add tests for mandatory audit success**

Add a route test to one role route proving a successful edit creates an audit entry:

```rust
#[async_std::test]
async fn editing_role_creates_audit_entry() {
    let harness = TestHarness::new().await;
    let (owner, server) = harness.create_user_and_server().await;
    let role = harness.create_role(&server, "Mods").await;

    let response = harness
        .client
        .patch(format!("/servers/{}/roles/{}", server.id, role.id))
        .header(harness.auth_header(&owner))
        .json(&json!({ "name": "Moderators" }))
        .dispatch()
        .await;

    assert_eq!(response.status(), Status::Ok);

    let entries = harness
        .db
        .fetch_server_audit_logs(
            &server.id,
            ServerAuditLogQuery {
                limit: 10,
                ..Default::default()
            },
        )
        .await
        .expect("audit entries");

    assert!(entries.iter().any(|entry| matches!(entry.action, ServerAuditLogAction::RoleUpdate)));
}
```

- [ ] **Step 9: Run role route tests**

Run:

```sh
cargo test --manifest-path services/backend/Cargo.toml -p syrnike-delta roles_
```

Expected after this task: role route tests pass and audit entries are created.

- [ ] **Step 10: Commit**

```sh
git add services/backend/crates/delta/src/routes/servers/audit_mutation.rs services/backend/crates/delta/src/routes/servers/mod.rs services/backend/crates/delta/src/routes/servers/roles_create.rs services/backend/crates/delta/src/routes/servers/roles_edit.rs services/backend/crates/delta/src/routes/servers/roles_delete.rs services/backend/crates/delta/src/routes/servers/roles_edit_positions.rs services/backend/crates/delta/src/routes/servers/permissions_set.rs services/backend/crates/delta/src/routes/servers/permissions_set_default.rs
git commit -m "feat: audit role and permission mutations"
```

---

### Task 4: Fix Frontend Server Settings Permission Entry Points

**Files:**
- Modify: `apps/web/src/lib/permissions.ts`
- Modify: `apps/web/src/lib/permissions.test.ts`
- Modify: `apps/web/src/components/servers/server-settings-types.ts`
- Modify: `apps/web/src/components/servers/server-settings-page.tsx`

- [ ] **Step 1: Add failing permission tests**

Add tests to `apps/web/src/lib/permissions.test.ts`:

```ts
import {
  canOpenServerSettings,
  canViewServerSettingsTab,
  getServerSettingsAccess,
} from '#/lib/permissions'
import { ServerPermission } from '#/lib/server-permissions'

it('allows role managers to open server settings without ManageServer', () => {
  const server = makeServerWithDefaultPermissions(0)
  const role = makeRole('role-1', {
    permissions: ServerPermission.ManageRole,
    rank: 1,
  })
  server.roles = { [role._id]: role }
  const member = makeMember(server._id, 'user-1', [role._id])

  const access = getServerSettingsAccess(server, [], member, 'user-1')

  expect(canOpenServerSettings(access)).toBe(true)
  expect(canViewServerSettingsTab(access, 'roles')).toBe(true)
  expect(canViewServerSettingsTab(access, 'overview')).toBe(false)
})

it('allows ban managers to open the bans tab without ManageServer', () => {
  const server = makeServerWithDefaultPermissions(ServerPermission.BanMembers)
  const member = makeMember(server._id, 'user-1', [])

  const access = getServerSettingsAccess(server, [], member, 'user-1')

  expect(canOpenServerSettings(access)).toBe(true)
  expect(canViewServerSettingsTab(access, 'bans')).toBe(true)
  expect(canViewServerSettingsTab(access, 'audit')).toBe(false)
})
```

Use existing test factories in the file. If names differ, keep the assertions and construct `Server`, `Role`, and `Member` with the local helpers already used by nearby tests.

- [ ] **Step 2: Extend tab types**

Modify `apps/web/src/components/servers/server-settings-types.ts`:

```ts
export type ServerSettingsTab =
  | 'overview'
  | 'emoji'
  | 'roles'
  | 'members'
  | 'bans'
  | 'invites'
  | 'audit'

export const SERVER_SETTINGS_TABS: ServerSettingsTab[] = [
  'overview',
  'emoji',
  'roles',
  'members',
  'bans',
  'invites',
  'audit',
]

export function parseServerSettingsTab(value: unknown): ServerSettingsTab {
  if (
    typeof value === 'string' &&
    SERVER_SETTINGS_TABS.includes(value as ServerSettingsTab)
  ) {
    return value as ServerSettingsTab
  }
  if (value === 'general') return 'overview'
  return 'overview'
}
```

Keep label values in the project's current UI language style. Do not add labels for excluded modules.

- [ ] **Step 3: Add settings access helpers**

Modify `apps/web/src/lib/permissions.ts`:

```ts
export type ServerSettingsAccess = {
  overview: boolean
  emoji: boolean
  roles: boolean
  members: boolean
  bans: boolean
  invites: boolean
  audit: boolean
}

export function getServerSettingsAccess(
  server: Server,
  channels: Channel[],
  member: Member | undefined,
  userId: string | undefined,
): ServerSettingsAccess {
  const serverPermissions = calculateServerPermissions(server, member, userId)
  const has = (permission: number) =>
    hasChannelPermission(serverPermissions, permission)

  const canInvite = channels.some(
    (channel) =>
      channel.channel_type === 'TextChannel' &&
      hasChannelPermission(
        calculateChannelPermissions(server, channel, member, userId),
        ChannelPermission.InviteOthers,
      ),
  )

  return {
    overview: has(ChannelPermission.ManageServer),
    emoji: has(ChannelPermission.ManageCustomisation),
    roles:
      has(ChannelPermission.ManageRole) ||
      has(ChannelPermission.ManagePermissions),
    members:
      has(ChannelPermission.KickMembers) ||
      has(ChannelPermission.BanMembers) ||
      has(ChannelPermission.TimeoutMembers) ||
      has(ChannelPermission.AssignRoles) ||
      has(ChannelPermission.ManageNicknames) ||
      has(ChannelPermission.ManageServer),
    bans: has(ChannelPermission.BanMembers),
    invites: has(ChannelPermission.ManageServer) || canInvite,
    audit: has(ChannelPermission.ManageServer),
  }
}

export function canOpenServerSettings(access: ServerSettingsAccess): boolean {
  return Object.values(access).some(Boolean)
}

export function canViewServerSettingsTab(
  access: ServerSettingsAccess,
  tab: ServerSettingsTab,
): boolean {
  return access[tab]
}
```

Update `getServerMenuPermissions()`:

```ts
const settingsAccess = getServerSettingsAccess(server, channels, member, userId)

return {
  invite: canInvite,
  settings: canOpenServerSettings(settingsAccess),
  createChannel: hasChannelPermission(
    serverPermissions,
    ChannelPermission.ManageChannel,
  ),
  leave: Boolean(member),
  copyId: Boolean(member),
}
```

- [ ] **Step 4: Gate settings page by section access**

Modify `apps/web/src/components/servers/server-settings-page.tsx`:

```ts
const settingsAccess = server
  ? getServerSettingsAccess(server, channels, member, auth.user?._id)
  : null
const canOpenSettings = settingsAccess
  ? canOpenServerSettings(settingsAccess)
  : false
const canViewCurrentTab = settingsAccess
  ? canViewServerSettingsTab(settingsAccess, tab)
  : false
```

Replace the redirect gate:

```ts
if (!server) return
if (!canOpenSettings) {
  void navigate({ to: prefix, search: { tab: 'online' }, replace: true })
  return
}
if (!canViewCurrentTab) {
  const firstTab = SERVER_SETTINGS_TABS.find((candidate) =>
    canViewServerSettingsTab(settingsAccess, candidate),
  )
  void navigate({
    to: `${prefix}/servers/$serverId/settings`,
    params: { serverId },
    search: { tab: firstTab ?? 'overview' },
    replace: true,
  })
}
```

Render each nav link only when `canViewServerSettingsTab(settingsAccess, tab)` is true.

- [ ] **Step 5: Run frontend permission tests**

Run:

```sh
pnpm --filter @syrnike13/web test src/lib/permissions.test.ts
```

Expected after this task: permission tests pass.

- [ ] **Step 6: Commit**

```sh
git add apps/web/src/lib/permissions.ts apps/web/src/lib/permissions.test.ts apps/web/src/components/servers/server-settings-types.ts apps/web/src/components/servers/server-settings-page.tsx
git commit -m "fix: gate server settings by section permissions"
```

---

### Task 5: Fix Realtime And Security Invariants

**Files:**
- Modify: `services/backend/crates/core/database/src/models/servers/ops/mongodb.rs`
- Modify: `services/backend/crates/bonfire/src/events/impl.rs`
- Modify: `services/backend/crates/daemons/pushd/src/consumers/inbound/mass_mention.rs`
- Modify: `apps/web/src/features/sync/sync-store.ts`
- Add tests beside modified modules

- [ ] **Step 1: Fix role deletion cleanup**

Modify `services/backend/crates/core/database/src/models/servers/ops/mongodb.rs`:

```rust
self.col::<Document>("channels")
    .update_many(
        doc! {
            "server": server_id
        },
        doc! {
            "$unset": {
                "role_permissions.".to_owned() + role_id: 1_i32
            }
        },
    )
    .await
    .map_err(|_| create_database_error!("update_many", "channels"))?;
```

Add a database test proving two channels both lose the deleted role permission overwrite.

- [ ] **Step 2: Queue bonfire visibility recalculation on role reorder**

Modify `services/backend/crates/bonfire/src/events/impl.rs` near `ServerRoleUpdate` handling:

```rust
EventV1::ServerRoleRanksUpdate { id, ranks } => {
    if let Some(server) = self.cache.servers.get_mut(id) {
        for (rank, role_id) in ranks.iter().enumerate() {
            if let Some(role) = server.roles.get_mut(role_id) {
                role.rank = rank as i64;
            }
        }
    }

    if let Some(member) = self.cache.members.get(id) {
        if ranks.iter().any(|role_id| member.roles.contains(role_id)) {
            queue_server = Some(id.clone());
        }
    }
}
```

Add a bonfire event test proving a current user's role rank reorder queues server visibility recalculation.

- [ ] **Step 3: Filter everyone mentions by channel visibility**

Modify `services/backend/crates/daemons/pushd/src/consumers/inbound/mass_mention.rs` everyone branch.

Replace direct `userids` fanout with visibility-filtered members:

```rust
let mut q = query.clone().members(&chunk);
let viewing_members: Vec<String> = q
    .members_can_see_channel()
    .await
    .iter()
    .filter_map(|(uid, viewable)| {
        if *viewable && !existing_mentions.contains(uid) {
            Some(uid.clone())
        } else {
            None
        }
    })
    .collect();

if let Err(err) = self
    .db
    .add_mention_to_many_unreads(push.channel.id(), &viewing_members, &ack_chnl)
    .await
{
    syrnike_config::capture_error(&err);
}

let online_users = syrnike_presence::filter_online(&viewing_members).await;
let target_users: Vec<String> = viewing_members
    .iter()
    .filter(|id| !online_users.contains(*id))
    .cloned()
    .collect();
```

Add a test where one member cannot view the channel and receives no unread or notification target.

- [ ] **Step 4: Use full member payload on frontend join**

Modify `apps/web/src/features/sync/sync-store.ts`:

```ts
case 'ServerMemberJoin': {
  const { member } = event as {
    id: string
    user: string
    member: Member
  }
  this.upsertMembers([member])
  break
}
```

- [ ] **Step 5: Preserve clear-field behavior for member updates**

Modify `ServerMemberUpdate` handling so unloaded members receive minimal state:

```ts
const existing =
  state.members[key] ??
  ({
    _id: { server: id.server, user: id.user },
  } as Member)
```

Keep the existing clear switch. Upsert the member after applying clear fields.

- [ ] **Step 6: Clean current user removal from server state**

Modify `ServerMemberLeave` handling:

```ts
const currentUserId = this.getState().authUserId
if (userId === currentUserId) {
  this.removeServer(serverId)
  if (state.selectedServerId === serverId) {
    this.setSelectedServerId(null)
  }
  break
}
this.removeServerMember(serverId, userId)
```

Use the store's existing auth/current-user field name. If no field exists, add a selector-safe helper that receives current user id where sync events are applied.

- [ ] **Step 7: Add sync-store tests**

Add tests covering:

```ts
it('stores full member from ServerMemberJoin', () => {
  syncStore.applyEvent({
    type: 'ServerMemberJoin',
    id: 'server-1',
    user: 'user-1',
    member: {
      _id: { server: 'server-1', user: 'user-1' },
      roles: ['role-1'],
      nickname: 'Ava',
    },
  })

  expect(syncStore.getState().members['server-1:user-1']?.roles).toEqual([
    'role-1',
  ])
})
```

Add a second test for unloaded `ServerMemberUpdate` and a third test for current-user leave cleanup.

- [ ] **Step 8: Run targeted tests**

Run:

```sh
cargo test --manifest-path services/backend/Cargo.toml -p syrnike-database delete_role
cargo test --manifest-path services/backend/Cargo.toml -p syrnike-bonfire ServerRoleRanksUpdate
cargo test --manifest-path services/backend/Cargo.toml -p syrnike-pushd mass_mention
pnpm --filter @syrnike13/web test src/features/sync/sync-store
```

Expected after this task: targeted backend and frontend sync tests pass.

- [ ] **Step 9: Commit**

```sh
git add services/backend/crates/core/database/src/models/servers/ops/mongodb.rs services/backend/crates/bonfire/src/events/impl.rs services/backend/crates/daemons/pushd/src/consumers/inbound/mass_mention.rs apps/web/src/features/sync/sync-store.ts
git commit -m "fix: enforce realtime permission invariants"
```

---

### Task 6: Add Invite Lifecycle Model, Routes, And Migration

**Files:**
- Modify: `services/backend/crates/core/database/src/models/channel_invites/model.rs`
- Modify: `services/backend/crates/core/database/src/models/channel_invites/ops.rs`
- Modify: `services/backend/crates/core/database/src/models/channel_invites/ops/reference.rs`
- Modify: `services/backend/crates/core/database/src/models/channel_invites/ops/mongodb.rs`
- Modify: `services/backend/crates/core/models/src/v0/invites.rs`
- Modify: `services/backend/crates/core/database/src/models/admin_migrations/ops/mongodb/scripts.rs`
- Modify: `services/backend/crates/delta/src/routes/channels/invite_create.rs`
- Modify: `services/backend/crates/delta/src/routes/servers/invites_fetch.rs`
- Modify: `services/backend/crates/delta/src/routes/invites/invite_join.rs`
- Modify: `services/backend/crates/delta/src/routes/invites/invite_delete.rs`
- Test: invite model and route files

- [ ] **Step 1: Replace invite model shape**

Modify `services/backend/crates/core/database/src/models/channel_invites/model.rs`:

```rust
auto_derived!(
    #[serde(tag = "type")]
    pub enum Invite {
        Server {
            #[serde(rename = "_id")]
            code: String,
            server: String,
            creator: String,
            channel: String,
            created_at: u64,
            expires_at: Option<u64>,
            max_uses: Option<u64>,
            uses: u64,
            revoked_at: Option<u64>,
            revoked_by: Option<String>,
            temporary: bool,
        },
        Group {
            #[serde(rename = "_id")]
            code: String,
            creator: String,
            channel: String,
            created_at: u64,
            expires_at: Option<u64>,
            max_uses: Option<u64>,
            uses: u64,
            revoked_at: Option<u64>,
            revoked_by: Option<String>,
            temporary: bool,
        },
    }
);
```

Add methods:

```rust
pub fn is_revoked(&self) -> bool {
    match self {
        Invite::Server { revoked_at, .. } | Invite::Group { revoked_at, .. } => revoked_at.is_some(),
    }
}

pub fn is_exhausted(&self) -> bool {
    match self {
        Invite::Server { max_uses, uses, .. } | Invite::Group { max_uses, uses, .. } => {
            max_uses.is_some_and(|max| *uses >= max)
        }
    }
}

pub fn is_expired(&self, now: u64) -> bool {
    match self {
        Invite::Server { expires_at, .. } | Invite::Group { expires_at, .. } => {
            expires_at.is_some_and(|expires_at| expires_at <= now)
        }
    }
}
```

- [ ] **Step 2: Add create payload types**

Modify `services/backend/crates/core/models/src/v0/invites.rs`:

```rust
auto_derived!(
    #[derive(Validate)]
    pub struct DataCreateInvite {
        #[validate(range(min = 0, max = 604800))]
        pub max_age_seconds: Option<u64>,
        #[validate(range(min = 0, max = 100))]
        pub max_uses: Option<u64>,
        pub temporary: Option<bool>,
        #[validate(length(max = 512))]
        pub reason: Option<String>,
    }
);
```

Expose lifecycle fields on public invite structs.

- [ ] **Step 3: Extend invite operations**

Modify `services/backend/crates/core/database/src/models/channel_invites/ops.rs`:

```rust
async fn increment_invite_uses(&self, code: &str) -> Result<Invite>;

async fn revoke_invite(
    &self,
    code: &str,
    revoked_at: u64,
    revoked_by: &str,
) -> Result<Invite>;
```

Implement both in reference and Mongo ops.

Mongo increment:

```rust
query!(
    self,
    update_one,
    COL,
    doc! { "_id": code },
    doc! { "$inc": { "uses": 1_i32 } }
)?;
self.fetch_invite(code).await
```

Mongo revoke:

```rust
query!(
    self,
    update_one,
    COL,
    doc! { "_id": code },
    doc! {
        "$set": {
            "revoked_at": revoked_at as i64,
            "revoked_by": revoked_by,
        }
    }
)?;
self.fetch_invite(code).await
```

- [ ] **Step 4: Add migration 52**

If Task 2 already raised `LATEST_REVISION` to `52`, raise it to `53` and add:

```rust
if revision <= 52 {
    info!("Running migration [revision 52 / 18-06-2026]: Add invite lifecycle fields.");

    let now = Timestamp::now_utc().duration_since(Timestamp::UNIX_EPOCH).whole_milliseconds() as i64;

    db.col::<Document>("channel_invites")
        .update_many(
            doc! {},
            doc! {
                "$set": {
                    "created_at": now,
                    "uses": 0_i64,
                    "expires_at": Bson::Null,
                    "max_uses": Bson::Null,
                    "revoked_at": Bson::Null,
                    "revoked_by": Bson::Null,
                    "temporary": false,
                }
            },
        )
        .await
        .expect("Failed to add invite lifecycle fields.");
}
```

Use the timestamp helper already available in `scripts.rs`. If the exact helper differs, store `SystemTime` milliseconds as an integer and keep all invite timestamps in milliseconds.

- [ ] **Step 5: Update create invite route**

Modify `services/backend/crates/delta/src/routes/channels/invite_create.rs` signature:

```rust
#[post("/<target>/invites", data = "<data>")]
pub async fn create_invite(
    db: &State<Database>,
    user: User,
    target: Reference<'_>,
    data: Json<v0::DataCreateInvite>,
) -> Result<Json<v0::Invite>> {
```

Validate data:

```rust
let data = data.into_inner();
data.validate().map_err(|error| {
    create_error!(FailedValidation {
        error: error.to_string()
    })
})?;
```

Pass lifecycle options into `Invite::create_channel_invite`.

- [ ] **Step 6: Reject invalid invite joins**

Modify `services/backend/crates/delta/src/routes/invites/invite_join.rs` after fetching invite:

```rust
let now = audit_timestamp();
if invite.is_revoked() || invite.is_expired(now) || invite.is_exhausted() {
    return Err(create_error!(InvalidInvite));
}
```

After successful join:

```rust
db.increment_invite_uses(invite.code()).await?;
```

- [ ] **Step 7: Audit invite create/delete/revoke**

Use Task 3 helper in:

- `services/backend/crates/delta/src/routes/channels/invite_create.rs`
- `services/backend/crates/delta/src/routes/invites/invite_delete.rs`

Use actions:

```rust
ServerAuditLogAction::InviteCreate
ServerAuditLogAction::InviteDelete
ServerAuditLogTarget::Invite { code: invite.code().to_string() }
```

- [ ] **Step 8: Add invite tests**

Add route tests covering:

```rust
#[async_std::test]
async fn exhausted_invite_cannot_be_joined() {
    let harness = TestHarness::new().await;
    let (owner, server) = harness.create_user_and_server().await;
    let channel = harness.first_text_channel(&server).await;
    let invite = harness
        .create_invite(&owner, &channel, json!({ "max_uses": 1 }))
        .await;

    let first_user = harness.create_user().await;
    harness.join_invite(&first_user, invite.code()).await.expect("first join");

    let second_user = harness.create_user().await;
    let response = harness
        .client
        .post(format!("/invites/{}", invite.code()))
        .header(harness.auth_header(&second_user))
        .dispatch()
        .await;

    assert_eq!(response.status(), Status::BadRequest);
}
```

Add companion tests for expired and revoked invites.

- [ ] **Step 9: Run invite tests**

Run:

```sh
cargo test --manifest-path services/backend/Cargo.toml -p syrnike-delta invite
cargo test --manifest-path services/backend/Cargo.toml -p syrnike-database channel_invites
```

Expected after this task: invite lifecycle tests pass.

- [ ] **Step 10: Commit**

```sh
git add services/backend/crates/core/database/src/models/channel_invites services/backend/crates/core/models/src/v0/invites.rs services/backend/crates/core/database/src/models/admin_migrations/ops/mongodb/scripts.rs services/backend/crates/delta/src/routes/channels/invite_create.rs services/backend/crates/delta/src/routes/servers/invites_fetch.rs services/backend/crates/delta/src/routes/invites/invite_join.rs services/backend/crates/delta/src/routes/invites/invite_delete.rs
git commit -m "feat: add server invite lifecycle"
```

---

### Task 7: Add Moderation Audit Coverage

**Files:**
- Modify: `services/backend/crates/core/models/src/v0/servers.rs`
- Modify: `services/backend/crates/delta/src/routes/servers/member_edit.rs`
- Modify: `services/backend/crates/delta/src/routes/servers/member_remove.rs`
- Modify: `services/backend/crates/delta/src/routes/servers/ban_create.rs`
- Modify: `services/backend/crates/delta/src/routes/servers/ban_remove.rs`
- Test: same route files

- [ ] **Step 1: Add reason payload for kick and unban**

Modify `services/backend/crates/core/models/src/v0/servers.rs`:

```rust
auto_derived!(
    #[derive(Validate)]
    pub struct DataModerationAction {
        #[validate(length(max = 512))]
        pub reason: Option<String>,
    }
);
```

Update kick route signature:

```rust
#[delete("/<server_id>/members/<member_id>", data = "<data>")]
pub async fn kick(
    db: &State<Database>,
    voice_client: &State<VoiceClient>,
    user: User,
    server_id: Reference<'_>,
    member_id: Reference<'_>,
    data: Option<Json<v0::DataModerationAction>>,
) -> Result<EmptyResponse> {
```

Normalize:

```rust
let reason = data.and_then(|data| data.into_inner().reason);
```

Repeat for unban.

- [ ] **Step 2: Audit kick**

In `member_remove.rs`, insert pending audit before `member.remove(db, &server, RemovalIntention::Kick, false)`:

```rust
let mut audit = audit_mutation::insert_pending_audit(
    db,
    server.id.clone(),
    user.id.clone(),
    ServerAuditLogAction::MemberKick,
    ServerAuditLogTarget::Member {
        user_id: member_id.id.to_string(),
    },
    reason,
    audit_mutation::audit_changes(vec![(
        "member",
        audit_mutation::audit_change(Some(member.clone()), None::<syrnike_database::Member>),
    )]),
)
        .await?;
```

Mark failed on remove or voice kick error. Mark succeeded after voice cleanup succeeds.

- [ ] **Step 3: Audit ban**

In `ban_create.rs`, audit before member removal or ban creation:

```rust
ServerAuditLogAction::MemberBan
ServerAuditLogTarget::User { id: target.id.to_string() }
```

Changes:

```rust
audit_mutation::audit_changes(vec![
    ("reason", audit_mutation::audit_change::<String>(None, data.reason.clone())),
    (
        "delete_message_seconds",
        audit_mutation::audit_change::<u32>(None, data.delete_message_seconds),
    ),
])
```

Mark succeeded only after `ServerBan::create(db, &server, target.id, data.reason)` succeeds.

- [ ] **Step 4: Audit unban**

In `ban_remove.rs`, fetch ban first, insert audit, delete ban, mark succeeded:

```rust
ServerAuditLogAction::MemberUnban
ServerAuditLogTarget::User { id: target.id.to_string() }
```

- [ ] **Step 5: Audit member edit and timeouts**

In `member_edit.rs`, select action:

```rust
let action = if data.timeout.is_some() || data.remove.contains(&v0::FieldsMember::Timeout) {
    ServerAuditLogAction::MemberTimeout
} else {
    ServerAuditLogAction::MemberUpdate
};
```

Target:

```rust
ServerAuditLogTarget::Member {
    user_id: member.id.user.clone(),
}
```

Changes include `nickname`, `roles`, `timeout`, `can_publish`, `can_receive`, and `voice_channel` when present.

- [ ] **Step 6: Add moderation route tests**

Add tests:

```rust
#[async_std::test]
async fn banning_member_writes_audit_reason() {
    let harness = TestHarness::new().await;
    let (owner, server) = harness.create_user_and_server().await;
    let target = harness.create_user().await;

    let response = harness
        .client
        .put(format!("/servers/{}/bans/{}", server.id, target.id))
        .header(harness.auth_header(&owner))
        .json(&json!({ "reason": "spam", "delete_message_seconds": 0 }))
        .dispatch()
        .await;

    assert_eq!(response.status(), Status::Ok);

    let entries = harness
        .db
        .fetch_server_audit_logs(&server.id, ServerAuditLogQuery { limit: 10, ..Default::default() })
        .await
        .expect("audit entries");

    assert!(entries.iter().any(|entry| {
        matches!(entry.action, ServerAuditLogAction::MemberBan)
            && entry.reason.as_deref() == Some("spam")
    }));
}
```

Add companion tests for kick, unban, role update, and timeout.

- [ ] **Step 7: Run moderation tests**

Run:

```sh
cargo test --manifest-path services/backend/Cargo.toml -p syrnike-delta member_
cargo test --manifest-path services/backend/Cargo.toml -p syrnike-delta ban_
```

Expected after this task: moderation route tests pass and audit entries exist.

- [ ] **Step 8: Commit**

```sh
git add services/backend/crates/core/models/src/v0/servers.rs services/backend/crates/delta/src/routes/servers/member_edit.rs services/backend/crates/delta/src/routes/servers/member_remove.rs services/backend/crates/delta/src/routes/servers/ban_create.rs services/backend/crates/delta/src/routes/servers/ban_remove.rs
git commit -m "feat: audit moderation actions"
```

---

### Task 8: Generate API Types And Add Frontend API Clients

**Files:**
- Modify generated: `packages/api-types/OpenAPI.json`
- Modify generated: `packages/api-types/src/schema.ts`
- Modify generated: `packages/api-types/src/types.ts`
- Modify: `apps/web/src/features/api/invites-api.ts`
- Modify: `apps/web/src/features/api/servers-api.ts`

- [ ] **Step 1: Generate API types**

Run:

```sh
pnpm api-types:generate
pnpm api-types:build
```

Expected after backend OpenAPI compiles: generated API files include `ServerAuditLogEntry`, `ServerAuditLogPage`, and `DataCreateInvite`.

- [ ] **Step 2: Add server audit API client**

Modify `apps/web/src/features/api/servers-api.ts`:

```ts
import type {
  BanListResult,
  DataModerationAction,
  ServerAuditLogPage,
} from '@syrnike13/api-types'

export async function fetchServerAuditLog(
  token: string,
  serverId: string,
  params: { before?: string; actor?: string; limit?: number } = {},
) {
  const search = new URLSearchParams()
  if (params.before) search.set('before', params.before)
  if (params.actor) search.set('actor', params.actor)
  if (params.limit) search.set('limit', String(params.limit))
  const suffix = search.toString() ? `?${search}` : ''
  return apiRequest<ServerAuditLogPage>(`/servers/${serverId}/audit-log${suffix}`, {
    token,
  })
}

export async function unbanServerMember(
  token: string,
  serverId: string,
  userId: string,
  body: DataModerationAction = {},
) {
  return apiRequest<void>(`/servers/${serverId}/bans/${userId}`, {
    token,
    method: 'DELETE',
    body,
  })
}
```

Keep existing `fetchServerBans`, `kickServerMember`, and `banServerMember`; update them to pass reason payloads.

- [ ] **Step 3: Add lifecycle invite API client**

Modify `apps/web/src/features/api/invites-api.ts`:

```ts
import type { DataCreateInvite, Invite } from '@syrnike13/api-types'

export async function createChannelInvite(
  token: string,
  channelId: string,
  body: DataCreateInvite = {},
) {
  return apiRequest<Invite>(`/channels/${channelId}/invites`, {
    token,
    method: 'POST',
    body,
  })
}

export async function deleteInvite(token: string, code: string) {
  return apiRequest<void>(`/invites/${code}`, {
    token,
    method: 'DELETE',
  })
}
```

- [ ] **Step 4: Add API tests only if API client tests exist**

Search:

```sh
rg -n --glob '!node_modules/**' "apiRequest|fetchServerAuditLog|createChannelInvite" apps/web/src/**/*.test.ts*
```

If API client tests exist, add tests for query string construction and invite create body. If no API client test pattern exists, skip client tests and cover behavior through settings panel tests in Task 9.

- [ ] **Step 5: Run frontend build for generated types**

Run:

```sh
pnpm --filter @syrnike13/api-types build
pnpm --filter @syrnike13/web test src/lib/permissions.test.ts
```

Expected after this task: generated types compile and permission tests still pass.

- [ ] **Step 6: Commit**

```sh
git add packages/api-types/OpenAPI.json packages/api-types/src/schema.ts packages/api-types/src/types.ts apps/web/src/features/api/invites-api.ts apps/web/src/features/api/servers-api.ts
git commit -m "feat: add server admin API clients"
```

---

### Task 9: Add Foundation Server Settings Panels

**Files:**
- Add: `apps/web/src/components/servers/server-settings-audit-panel.tsx`
- Add: `apps/web/src/components/servers/server-settings-invites-panel.tsx`
- Add: `apps/web/src/components/servers/server-settings-bans-panel.tsx`
- Modify: `apps/web/src/components/servers/server-settings-panels.tsx`
- Modify: `apps/web/src/components/servers/server-settings-page.tsx`
- Test: panel tests beside added files

- [ ] **Step 1: Add audit panel**

Create `apps/web/src/components/servers/server-settings-audit-panel.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query'

import { fetchServerAuditLog } from '#/features/api/servers-api'
import { useAuth } from '#/features/auth/auth-context'

export function ServerSettingsAuditPanel({ serverId }: { serverId: string }) {
  const auth = useAuth()
  const token = auth.session?.token

  const query = useQuery({
    queryKey: ['server-audit-log', serverId],
    enabled: Boolean(token),
    queryFn: () => fetchServerAuditLog(token!, serverId, { limit: 50 }),
  })

  if (query.isLoading) return <p className="text-sm text-muted-foreground">Loading audit log</p>
  if (query.isError) return <p className="text-sm text-destructive">Failed to load audit log.</p>

  return (
    <div className="space-y-3">
      <h2 className="text-xl font-semibold">Audit Log</h2>
      <div className="divide-y divide-border rounded-md border border-border">
        {query.data?.entries.map((entry) => (
          <div key={entry._id} className="p-3 text-sm">
            <div className="font-medium">{entry.action.type}</div>
            <div className="text-muted-foreground">
              Actor {entry.actor_id}
              {entry.reason ? ` - ${entry.reason}` : ''}
            </div>
          </div>
        ))}
        {query.data?.entries.length === 0 ? (
          <div className="p-3 text-sm text-muted-foreground">No audit events yet.</div>
        ) : null}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Add invites panel**

Create `apps/web/src/components/servers/server-settings-invites-panel.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'

import {
  createChannelInvite,
  deleteInvite,
  fetchServerInvites,
} from '#/features/api/invites-api'
import { useAuth } from '#/features/auth/auth-context'
import { listServerChannels } from '#/features/sync/selectors'
import { useSyncStore } from '#/features/sync/sync-store'
import { Button } from '#/components/ui/button'

export function ServerSettingsInvitesPanel({ serverId }: { serverId: string }) {
  const auth = useAuth()
  const token = auth.session?.token
  const channels = useSyncStore((s) => listServerChannels(s, serverId, auth.user?._id))
  const firstTextChannel = channels.find((channel) => channel.channel_type === 'TextChannel')

  const query = useQuery({
    queryKey: ['server-invites', serverId],
    enabled: Boolean(token),
    queryFn: () => fetchServerInvites(token!, serverId),
  })

  async function createInvite() {
    if (!token || !firstTextChannel) return
    await createChannelInvite(token, firstTextChannel._id, {
      max_age_seconds: 604800,
      max_uses: 0,
      temporary: false,
    })
    await query.refetch()
  }

  async function revokeInvite(code: string) {
    if (!token) return
    try {
      await deleteInvite(token, code)
      await query.refetch()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete invite')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Invites</h2>
        <Button type="button" onClick={() => void createInvite()} disabled={!firstTextChannel}>
          Create
        </Button>
      </div>
      <div className="divide-y divide-border rounded-md border border-border">
        {query.data?.map((invite) => (
          <div key={invite._id} className="flex items-center justify-between gap-3 p-3 text-sm">
            <div>
              <div className="font-medium">{invite._id}</div>
              <div className="text-muted-foreground">
                Uses {invite.uses ?? 0}
              </div>
            </div>
            <Button type="button" variant="outline" onClick={() => void revokeInvite(invite._id)}>
              Revoke
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}
```

Use the exact generated invite field names after Task 8; keep the component behavior unchanged.

- [ ] **Step 3: Add bans panel**

Create `apps/web/src/components/servers/server-settings-bans-panel.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'

import { fetchServerBans, unbanServerMember } from '#/features/api/servers-api'
import { useAuth } from '#/features/auth/auth-context'
import { Button } from '#/components/ui/button'

export function ServerSettingsBansPanel({ serverId }: { serverId: string }) {
  const auth = useAuth()
  const token = auth.session?.token
  const query = useQuery({
    queryKey: ['server-bans', serverId],
    enabled: Boolean(token),
    queryFn: () => fetchServerBans(token!, serverId),
  })

  async function unban(userId: string) {
    if (!token) return
    try {
      await unbanServerMember(token, serverId, userId)
      await query.refetch()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to unban')
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Bans</h2>
      <div className="divide-y divide-border rounded-md border border-border">
        {query.data?.bans.map((ban) => (
          <div key={ban._id.user} className="flex items-center justify-between gap-3 p-3 text-sm">
            <div>
              <div className="font-medium">{ban._id.user}</div>
              <div className="text-muted-foreground">{ban.reason ?? 'No reason'}</div>
            </div>
            <Button type="button" variant="outline" onClick={() => void unban(ban._id.user)}>
              Unban
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Route panels from settings content**

Modify `apps/web/src/components/servers/server-settings-panels.tsx`:

```tsx
import { ServerSettingsAuditPanel } from '#/components/servers/server-settings-audit-panel'
import { ServerSettingsInvitesPanel } from '#/components/servers/server-settings-invites-panel'
import { ServerSettingsBansPanel } from '#/components/servers/server-settings-bans-panel'
```

In `ServerSettingsPanelContent`:

```tsx
if (tab === 'overview') {
  return <ServerSettingsGeneralPanel serverId={serverId} serverName={server.name} />
}
if (tab === 'bans') {
  return <ServerSettingsBansPanel serverId={serverId} />
}
if (tab === 'invites') {
  return <ServerSettingsInvitesPanel serverId={serverId} />
}
if (tab === 'audit') {
  return <ServerSettingsAuditPanel serverId={serverId} />
}
```

Remove the old `general` branch after parser migration keeps old URLs redirecting to `overview`.

- [ ] **Step 5: Add panel tests**

Create tests that mock API calls and assert visible behavior:

```tsx
it('renders audit entries', async () => {
  mockFetchServerAuditLog.mockResolvedValue({
    entries: [
      {
        _id: 'audit-1',
        server_id: 'server-1',
        actor_id: 'user-1',
        action: { type: 'RoleCreate' },
        target: { type: 'Role', id: 'role-1' },
        reason: 'setup',
        changes: {},
        status: 'Succeeded',
        error: null,
        request_id: null,
        created_at: 1,
        completed_at: 2,
      },
    ],
    next_before: null,
  })

  render(<ServerSettingsAuditPanel serverId="server-1" />)

  expect(await screen.findByText('RoleCreate')).toBeInTheDocument()
  expect(screen.getByText(/setup/)).toBeInTheDocument()
})
```

Add one test for invite revoke button and one test for ban unban button.

- [ ] **Step 6: Run panel tests**

Run:

```sh
pnpm --filter @syrnike13/web test src/components/servers
```

Expected after this task: server settings component tests pass.

- [ ] **Step 7: Commit**

```sh
git add apps/web/src/components/servers/server-settings-audit-panel.tsx apps/web/src/components/servers/server-settings-invites-panel.tsx apps/web/src/components/servers/server-settings-bans-panel.tsx apps/web/src/components/servers/server-settings-panels.tsx apps/web/src/components/servers/server-settings-page.tsx
git commit -m "feat: add server admin foundation panels"
```

---

### Task 10: Final Verification For Foundation Slice

**Files:**
- No new files.
- Verify all files changed by Tasks 1-9.

- [ ] **Step 1: Check staged and unstaged scope**

Run:

```sh
git status --short --branch
```

Expected: only intentional foundation changes are present, plus any unrelated dirty files that existed before this plan. Do not stage unrelated chat/media/package changes.

- [ ] **Step 2: Run backend check**

Run:

```sh
pnpm backend:check
```

Expected: backend workspace compiles. If Rust toolchain or system dependencies block this command, capture the exact error and run narrower `cargo test` commands that cover modified crates.

- [ ] **Step 3: Run web tests**

Run:

```sh
pnpm web:test
```

Expected: web tests pass.

- [ ] **Step 4: Run web build**

Run:

```sh
pnpm web:build
```

Expected: production web build passes.

- [ ] **Step 5: Inspect generated API diff**

Run:

```sh
git diff -- packages/api-types/OpenAPI.json packages/api-types/src/schema.ts packages/api-types/src/types.ts
```

Expected: generated diff includes audit log and invite lifecycle types only from backend schema changes.

- [ ] **Step 6: Commit final verification fixes**

If verification required fixes:

```sh
git add <exact-fixed-files>
git commit -m "fix: stabilize server admin foundation"
```

If no fixes were required, do not create an empty commit.

---

## Self-Review Checklist

- Spec coverage: Tasks 1-3 cover audit model, read API, and mandatory audited mutations. Task 4 covers settings permission entry points. Task 5 covers realtime and security invariants. Task 6 covers invite lifecycle. Task 7 covers moderation audit. Task 9 covers foundation settings UI.
- Excluded features: no AutoMod, onboarding/community, integrations marketplace, forum channels, stage channels, or thread channels appear in implementation tasks.
- Type consistency: audit types use `ServerAuditLogEntry`, `ServerAuditLogAction`, `ServerAuditLogTarget`, `ServerAuditLogChange`, `ServerAuditLogStatus`, and `ServerAuditLogQuery` consistently.
- Verification: Task 10 requires `pnpm backend:check`, `pnpm web:test`, and `pnpm web:build`.
