use rocket::{serde::json::Json, State};
use syrnike_database::{
    util::{permissions::DatabasePermissionQuery, reference::Reference},
    voice::{reconcile_server_voice_permissions, VoiceClient},
    Database, ServerAuditLogAction, ServerAuditLogTarget, User,
};
use syrnike_models::v0;
use syrnike_permissions::{calculate_server_permissions, ChannelPermission};
use syrnike_result::{create_error, Result};

use super::{audit_mutation, hierarchy_policy};

/// # Edits server roles ranks
///
/// Edit's server role's ranks.
#[openapi(tag = "Server Permissions")]
#[patch("/<target>/roles/ranks", data = "<data>")]
pub async fn edit_role_ranks(
    db: &State<Database>,
    voice_client: &State<VoiceClient>,
    user: User,
    target: Reference<'_>,
    data: Json<v0::DataEditRoleRanks>,
) -> Result<Json<v0::Server>> {
    let data = data.into_inner();

    let mut server = target.as_server(db).await?;
    let mut query = DatabasePermissionQuery::new(db, &user).server(&server);
    calculate_server_permissions(&mut query)
        .await
        .throw_if_lacking_channel_permission(ChannelPermission::ManageRole)?;

    let existing_order = server
        .ordered_roles()
        .into_iter()
        .map(|(id, _)| id)
        .collect::<Vec<_>>();

    let new_order = data.ranks.clone().into_iter().collect::<Vec<_>>();

    // Verify all roles are in the new ordering
    if data.ranks.len() != server.roles.len()
        || !server.roles.iter().all(|(id, _)| data.ranks.contains(id))
    {
        return Err(create_error!(InvalidOperation));
    }

    // Don't have to check what the user can't modify if they are the server owner
    if !hierarchy_policy::bypasses_hierarchy(&user, &server) {
        let member_top_rank = query.get_member_rank();

        if server
            .roles
            .iter()
            // Find all roles above the member which we should not be able to reorder
            .filter(|(_, role)| {
                hierarchy_policy::role_is_at_or_above_actor(member_top_rank, role.rank)
            })
            // Check if user is trying to reorder roles they can't reorder (as found previously)
            .any(|(id, _)| {
                existing_order
                    .iter()
                    .position(|existing_id| id == existing_id)
                    != new_order.iter().position(|new_id| id == new_id)
            })
        {
            return Err(create_error!(NotElevated));
        }
    }

    let before_order = server
        .ordered_roles()
        .into_iter()
        .map(|(id, role)| (id, role.rank))
        .collect::<Vec<_>>();
    let after_order = new_order
        .iter()
        .enumerate()
        .map(|(rank, id)| (id.clone(), rank as i64))
        .collect::<Vec<_>>();
    let mut audit = audit_mutation::insert_pending_audit(
        db,
        server.id.clone(),
        user.id.clone(),
        ServerAuditLogAction::RoleReorder,
        ServerAuditLogTarget::Server {
            id: server.id.clone(),
        },
        None,
        audit_mutation::audit_changes(vec![(
            "ranks",
            audit_mutation::audit_change(Some(before_order), Some(after_order))?,
        )]),
    )
    .await?;

    if let Err(error) = server.set_role_ordering(db, new_order).await {
        return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
    }

    reconcile_server_voice_permissions(db, voice_client, &server, None).await;

    audit_mutation::mark_succeeded_after_commit(db, &mut audit).await;

    Ok(Json(server.into()))
}

#[cfg(test)]
fn routes_under_test() -> Vec<rocket::Route> {
    routes![edit_role_ranks]
}

#[cfg(test)]
mod test {
    use std::collections::HashMap;

    use authifier::{
        models::{Account, EmailVerification, Session},
        Authifier,
    };
    use rocket::http::{ContentType, Header, Status};
    use rocket::local::asynchronous::Client;
    use syrnike_database::{
        fixture, voice::VoiceClient, Database, DatabaseInfo, ServerAuditLogAction,
        ServerAuditLogQuery, ServerAuditLogStatus, ServerAuditLogTarget,
    };
    use syrnike_models::v0;
    use ulid::Ulid;

    struct RoleRanksTestContext {
        client: Client,
        db: Database,
        authifier: Authifier,
    }

    impl RoleRanksTestContext {
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
                    .manage(db.clone())
                    .manage(VoiceClient::new(HashMap::new())),
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

    #[rocket::async_test]
    async fn edit_role_rankings() {
        let context = RoleRanksTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            owner user 0
            moderator user 1
            server server 4);

        // Moderator can re-order the roles below them
        let moderator_id = moderator.id.clone();
        let owner_id = owner.id.clone();
        let (_, moderator_session) = context.account_from_user(moderator_id.clone()).await;
        let mut target_order: Vec<String> = server
            .ordered_roles()
            .into_iter()
            .map(|(id, _)| id)
            .collect();

        // Swap the two lower ranked roles
        target_order.swap(2, 3);

        let response = context
            .client
            .patch(format!("/servers/{}/roles/ranks", server.id))
            .header(ContentType::JSON)
            .body(
                json!(v0::DataEditRoleRanks {
                    ranks: target_order.clone()
                })
                .to_string(),
            )
            .header(Header::new(
                "x-session-token",
                moderator_session.token.to_string(),
            ))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::Ok);
        drop(response);

        // ... but not above them
        let mut target_order: Vec<String> = server
            .ordered_roles()
            .into_iter()
            .map(|(id, _)| id)
            .collect();

        // Swap the two lower ranked roles
        target_order.swap(0, 1);

        let response = context
            .client
            .patch(format!("/servers/{}/roles/ranks", server.id))
            .header(ContentType::JSON)
            .body(
                json!(v0::DataEditRoleRanks {
                    ranks: target_order.clone()
                })
                .to_string(),
            )
            .header(Header::new(
                "x-session-token",
                moderator_session.token.to_string(),
            ))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::Forbidden);
        drop(response);

        // The owner can set any order they want
        let (_, owner_session) = context.account_from_user(owner_id.clone()).await;

        let response = context
            .client
            .patch(format!("/servers/{}/roles/ranks", server.id))
            .header(ContentType::JSON)
            .body(
                json!(v0::DataEditRoleRanks {
                    ranks: target_order.clone()
                })
                .to_string(),
            )
            .header(Header::new(
                "x-session-token",
                owner_session.token.to_string(),
            ))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::Ok);
        drop(response);

        let entries = context
            .db
            .fetch_server_audit_logs(
                &server.id,
                ServerAuditLogQuery {
                    action: Some(ServerAuditLogAction::RoleReorder),
                    target_type: Some("Server".to_string()),
                    target_id: Some(server.id.clone()),
                    limit: 50,
                    ..Default::default()
                },
            )
            .await
            .expect("audit entries fetched");

        assert_eq!(entries.len(), 2);
        assert!(entries.iter().any(|entry| entry.actor_id == owner_id));
        assert!(entries.iter().any(|entry| entry.actor_id == moderator_id));

        for entry in entries {
            assert_eq!(entry.status, ServerAuditLogStatus::Succeeded);
            assert_eq!(
                entry.target,
                ServerAuditLogTarget::Server {
                    id: server.id.clone()
                }
            );
            assert!(entry.changes.contains_key("ranks"));
        }
    }
}
