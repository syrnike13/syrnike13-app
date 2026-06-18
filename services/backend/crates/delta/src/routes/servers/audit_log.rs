use rocket::{serde::json::Json, State};
use syrnike_database::{
    util::{permissions::DatabasePermissionQuery, reference::Reference},
    Database, ServerAuditLogAction, ServerAuditLogQuery, User,
};
use syrnike_models::v0;
use syrnike_permissions::{calculate_server_permissions, ChannelPermission};
use syrnike_result::{create_error, Result};

fn parse_audit_action(action: Option<String>) -> Result<Option<ServerAuditLogAction>> {
    let action = match action.as_deref() {
        None | Some("") => return Ok(None),
        Some("ServerUpdate") => ServerAuditLogAction::ServerUpdate,
        Some("RoleCreate") => ServerAuditLogAction::RoleCreate,
        Some("RoleUpdate") => ServerAuditLogAction::RoleUpdate,
        Some("RoleDelete") => ServerAuditLogAction::RoleDelete,
        Some("RoleReorder") => ServerAuditLogAction::RoleReorder,
        Some("MemberUpdate") => ServerAuditLogAction::MemberUpdate,
        Some("MemberKick") => ServerAuditLogAction::MemberKick,
        Some("MemberBan") => ServerAuditLogAction::MemberBan,
        Some("MemberUnban") => ServerAuditLogAction::MemberUnban,
        Some("MemberTimeout") => ServerAuditLogAction::MemberTimeout,
        Some("InviteCreate") => ServerAuditLogAction::InviteCreate,
        Some("InviteUpdate") => ServerAuditLogAction::InviteUpdate,
        Some("InviteRevoke") => ServerAuditLogAction::InviteRevoke,
        Some("InviteDelete") => ServerAuditLogAction::InviteDelete,
        Some("ChannelPermissionUpdate") => ServerAuditLogAction::ChannelPermissionUpdate,
        Some("ServerPermissionUpdate") => ServerAuditLogAction::ServerPermissionUpdate,
        Some(_) => return Err(create_error!(InvalidOperation)),
    };

    Ok(Some(action))
}

/// # Fetch Server Audit Log
///
/// Fetch server audit log entries.
#[openapi(tag = "Server Audit Log")]
#[get("/<server>/audit-log?<actor>&<action>&<target_type>&<target_id>&<before>&<limit>")]
pub async fn fetch_audit_log(
    db: &State<Database>,
    user: User,
    server: Reference<'_>,
    actor: Option<String>,
    action: Option<String>,
    target_type: Option<String>,
    target_id: Option<String>,
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
                action: parse_audit_action(action)?,
                actor_id: actor,
                target_type,
                target_id,
                before,
                limit: limit.unwrap_or(50).clamp(1, 100),
                ..Default::default()
            },
        )
        .await?
        .into_iter()
        .map(Into::into)
        .collect::<Vec<v0::ServerAuditLogEntry>>();

    let next_before = entries.last().map(|entry| entry.id.clone());

    Ok(Json(v0::ServerAuditLogPage {
        entries,
        next_before,
    }))
}

#[cfg(test)]
fn routes_under_test() -> Vec<rocket::Route> {
    routes![fetch_audit_log]
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use authifier::{
        models::{Account, EmailVerification, Session},
        Authifier,
    };
    use rocket::http::{Header, Status};
    use rocket::local::asynchronous::Client;
    use syrnike_database::{
        fixture, Database, DatabaseInfo, ServerAuditLogAction, ServerAuditLogEntry,
        ServerAuditLogStatus, ServerAuditLogTarget,
    };
    use syrnike_models::v0;
    use ulid::Ulid;

    struct AuditLogTestContext {
        client: Client,
        db: Database,
        authifier: Authifier,
    }

    impl AuditLogTestContext {
        async fn new() -> Self {
            let db = DatabaseInfo::Reference
                .connect()
                .await
                .expect("reference database");
            let authifier = db.clone().to_authifier().await;
            let client = Client::tracked(
                rocket::build()
                    .mount("/servers", super::routes_under_test())
                    .manage(authifier.clone())
                    .manage(db.clone()),
            )
            .await
            .expect("valid rocket instance");

            Self {
                client,
                db,
                authifier,
            }
        }

        async fn account_from_user(&self, id: String) -> (Account, Session) {
            let account = Account {
                id,
                email: format!("{}@syrnike13.ru", Ulid::new()),
                password: Default::default(),
                email_normalised: Default::default(),
                deletion: None,
                disabled: false,
                lockout: None,
                mfa: Default::default(),
                password_reset: None,
                verification: EmailVerification::Verified,
            };

            self.authifier
                .database
                .save_account(&account)
                .await
                .expect("account saved");

            let session = account
                .create_session(&self.authifier, String::new())
                .await
                .expect("session created");

            (account, session)
        }
    }

    fn audit_entry(
        id: &str,
        server_id: &str,
        actor_id: &str,
        created_at: u64,
    ) -> ServerAuditLogEntry {
        ServerAuditLogEntry {
            id: id.to_string(),
            server_id: server_id.to_string(),
            actor_id: actor_id.to_string(),
            action: ServerAuditLogAction::ServerUpdate,
            target: ServerAuditLogTarget::Server {
                id: server_id.to_string(),
            },
            reason: None,
            changes: HashMap::new(),
            status: ServerAuditLogStatus::Succeeded,
            error: None,
            request_id: None,
            created_at,
            completed_at: Some(created_at),
        }
    }

    fn audit_entry_with_action_and_target(
        id: &str,
        server_id: &str,
        actor_id: &str,
        created_at: u64,
        action: ServerAuditLogAction,
        target: ServerAuditLogTarget,
    ) -> ServerAuditLogEntry {
        ServerAuditLogEntry {
            action,
            target,
            ..audit_entry(id, server_id, actor_id, created_at)
        }
    }

    async fn insert_audit_entry(context: &AuditLogTestContext, entry: ServerAuditLogEntry) {
        context
            .db
            .insert_server_audit_log(&entry)
            .await
            .expect("audit log entry inserted");
    }

    #[rocket::async_test]
    async fn audit_log_requires_manage_server() {
        let context = AuditLogTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            owner user 0
            member user 2
            server server 4);

        let (_, member_session) = context.account_from_user(member.id).await;
        let response = context
            .client
            .get(format!("/servers/{}/audit-log", server.id))
            .header(Header::new(
                "x-session-token",
                member_session.token.to_string(),
            ))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::Forbidden);
        drop(response);

        let (_, owner_session) = context.account_from_user(owner.id).await;
        let response = context
            .client
            .get(format!("/servers/{}/audit-log", server.id))
            .header(Header::new(
                "x-session-token",
                owner_session.token.to_string(),
            ))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::Ok);
    }

    #[rocket::async_test]
    async fn audit_log_returns_entries_newest_first_with_cursor_and_actor_filter() {
        let context = AuditLogTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            owner user 0
            member user 2
            server server 4);

        insert_audit_entry(
            &context,
            audit_entry("01ARZ3NDEKTSV4RRFFQ69G5FAV", &server.id, &owner.id, 100),
        )
        .await;
        insert_audit_entry(
            &context,
            audit_entry("01ARZ3NDEKTSV4RRFFQ69G5FAW", &server.id, &member.id, 200),
        )
        .await;
        insert_audit_entry(
            &context,
            audit_entry("01ARZ3NDEKTSV4RRFFQ69G5FAX", &server.id, &owner.id, 300),
        )
        .await;
        insert_audit_entry(
            &context,
            audit_entry("01ARZ3NDEKTSV4RRFFQ69G5FAY", &server.id, &owner.id, 400),
        )
        .await;

        let (_, owner_session) = context.account_from_user(owner.id.clone()).await;
        let response = context
            .client
            .get(format!(
                "/servers/{}/audit-log?actor={}&limit=2",
                server.id, owner.id
            ))
            .header(Header::new(
                "x-session-token",
                owner_session.token.to_string(),
            ))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::Ok);
        let page: v0::ServerAuditLogPage = response.into_json().await.expect("audit log page");
        let ids = page
            .entries
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            ids,
            vec!["01ARZ3NDEKTSV4RRFFQ69G5FAY", "01ARZ3NDEKTSV4RRFFQ69G5FAX"]
        );
        assert_eq!(
            page.next_before.as_deref(),
            Some("01ARZ3NDEKTSV4RRFFQ69G5FAX")
        );
    }

    #[rocket::async_test]
    async fn audit_log_filters_by_action_and_target() {
        let context = AuditLogTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            owner user 0
            member user 2
            server server 4);

        insert_audit_entry(
            &context,
            audit_entry_with_action_and_target(
                "01ARZ3NDEKTSV4RRFFQ69G5FAV",
                &server.id,
                &owner.id,
                100,
                ServerAuditLogAction::MemberBan,
                ServerAuditLogTarget::User {
                    id: member.id.clone(),
                },
            ),
        )
        .await;
        insert_audit_entry(
            &context,
            audit_entry_with_action_and_target(
                "01ARZ3NDEKTSV4RRFFQ69G5FAW",
                &server.id,
                &owner.id,
                200,
                ServerAuditLogAction::MemberKick,
                ServerAuditLogTarget::Member {
                    user_id: member.id.clone(),
                },
            ),
        )
        .await;
        insert_audit_entry(
            &context,
            audit_entry_with_action_and_target(
                "01ARZ3NDEKTSV4RRFFQ69G5FAX",
                &server.id,
                &owner.id,
                300,
                ServerAuditLogAction::MemberBan,
                ServerAuditLogTarget::User {
                    id: owner.id.clone(),
                },
            ),
        )
        .await;

        let (_, owner_session) = context.account_from_user(owner.id.clone()).await;
        let response = context
            .client
            .get(format!(
                "/servers/{}/audit-log?action=MemberBan&target_type=User&target_id={}",
                server.id, member.id
            ))
            .header(Header::new(
                "x-session-token",
                owner_session.token.to_string(),
            ))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::Ok);
        let page: v0::ServerAuditLogPage = response.into_json().await.expect("audit log page");
        let ids = page
            .entries
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(ids, vec!["01ARZ3NDEKTSV4RRFFQ69G5FAV"]);
    }
}
