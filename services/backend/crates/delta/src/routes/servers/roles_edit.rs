use rocket::{serde::json::Json, State};
use syrnike_database::{
    util::{permissions::DatabasePermissionQuery, reference::Reference},
    Database, File, PartialRole, ServerAuditLogAction, ServerAuditLogTarget, User,
};
use syrnike_models::v0;
use syrnike_permissions::{calculate_server_permissions, ChannelPermission};
use syrnike_result::{create_error, Result};
use validator::Validate;

use super::audit_mutation;

/// # Edit Role
///
/// Edit a role by its id.
#[openapi(tag = "Server Permissions")]
#[patch("/<target>/roles/<role_id>", data = "<data>", rank = 1)]
pub async fn edit(
    db: &State<Database>,
    user: User,
    target: Reference<'_>,
    role_id: String,
    data: Json<v0::DataEditRole>,
) -> Result<Json<v0::Role>> {
    let data = data.into_inner();
    data.validate().map_err(|error| {
        create_error!(FailedValidation {
            error: error.to_string()
        })
    })?;

    let mut server = target.as_server(db).await?;
    let mut query = DatabasePermissionQuery::new(db, &user).server(&server);
    calculate_server_permissions(&mut query)
        .await
        .throw_if_lacking_channel_permission(ChannelPermission::ManageRole)?;

    let member_rank = query.get_member_rank().unwrap_or(i64::MIN);

    if let Some(mut role) = server.roles.remove(&role_id) {
        // Prevent us from editing roles above us
        if role.rank <= member_rank {
            return Err(create_error!(NotElevated));
        }

        let v0::DataEditRole {
            name,
            colour,
            hoist,
            mentionable,
            icon,
            remove,
            ..
        } = data;

        if remove.contains(&v0::FieldsRole::Colour) && colour.is_some() {
            return Err(create_error!(FailedValidation {
                error: "cannot set and remove role colour in the same request".to_string(),
            }));
        }

        if remove.contains(&v0::FieldsRole::Icon) && icon.is_some() {
            return Err(create_error!(FailedValidation {
                error: "cannot set and remove role icon in the same request".to_string(),
            }));
        }

        let mut change_entries = Vec::new();
        if let Some(new_name) = name.clone() {
            change_entries.push((
                "name",
                audit_mutation::audit_change(Some(role.name.clone()), Some(new_name))?,
            ));
        }
        if remove.contains(&v0::FieldsRole::Colour) {
            change_entries.push((
                "colour",
                audit_mutation::audit_change(role.colour.clone(), None::<String>)?,
            ));
        } else if let Some(new_colour) = colour.clone() {
            change_entries.push((
                "colour",
                audit_mutation::audit_change(role.colour.clone(), Some(new_colour))?,
            ));
        }
        if let Some(new_hoist) = hoist {
            change_entries.push((
                "hoist",
                audit_mutation::audit_change(Some(role.hoist), Some(new_hoist))?,
            ));
        }
        if let Some(new_mentionable) = mentionable {
            change_entries.push((
                "mentionable",
                audit_mutation::audit_change(Some(role.mentionable), Some(new_mentionable))?,
            ));
        }
        if remove.contains(&v0::FieldsRole::Icon) {
            change_entries.push((
                "icon",
                audit_mutation::audit_change(
                    role.icon.as_ref().map(|icon| icon.id.clone()),
                    None::<String>,
                )?,
            ));
        } else if let Some(new_icon) = icon.clone() {
            change_entries.push((
                "icon",
                audit_mutation::audit_change(
                    role.icon.as_ref().map(|icon| icon.id.clone()),
                    Some(new_icon),
                )?,
            ));
        }

        let database_remove = remove.iter().cloned().map(Into::into).collect::<Vec<_>>();
        let mut audit = audit_mutation::insert_pending_audit(
            db,
            server.id.clone(),
            user.id.clone(),
            ServerAuditLogAction::RoleUpdate,
            ServerAuditLogTarget::Role {
                id: role.id.clone(),
            },
            None,
            audit_mutation::audit_changes(change_entries),
        )
        .await?;

        if remove.contains(&v0::FieldsRole::Icon) {
            if let Some(existing_icon) = &role.icon {
                if let Err(error) = db.mark_attachment_as_deleted(&existing_icon.id).await {
                    return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
                }
            }
        }

        let mut final_icon = None;
        if let Some(icon_id) = icon {
            final_icon = match File::use_role_icon(db, &icon_id, &role_id, &user.id).await {
                Ok(icon) => Some(icon),
                Err(error) => {
                    return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
                }
            };
        }

        let partial = PartialRole {
            name,
            colour,
            hoist,
            mentionable,
            icon: final_icon,
            ..Default::default()
        };

        if let Err(error) = role.update(db, &server.id, partial, database_remove).await {
            return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
        }

        audit.mark_succeeded(db).await?;

        Ok(Json(role.into()))
    } else {
        Err(create_error!(NotFound))
    }
}

#[cfg(test)]
fn routes_under_test() -> Vec<rocket::Route> {
    routes![edit]
}

#[cfg(test)]
mod test {
    use authifier::{
        models::{Account, EmailVerification, Session},
        Authifier,
    };
    use rocket::http::{ContentType, Header, Status};
    use rocket::local::asynchronous::Client;
    use syrnike_database::{
        fixture, Channel, Database, DatabaseInfo, PartialServer, ServerAuditLogAction,
        ServerAuditLogQuery, ServerAuditLogStatus, ServerAuditLogTarget, VoiceInformation,
    };
    use syrnike_models::v0;
    use syrnike_permissions::OverrideField;
    use ulid::Ulid;

    struct RoleEditTestContext {
        client: Client,
        db: Database,
        authifier: Authifier,
    }

    impl RoleEditTestContext {
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

    #[rocket::async_test]
    async fn edit_role_creates_audit_entry() {
        let context = RoleEditTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            owner user 0
            server server 4);

        let role = server
            .roles
            .values()
            .find(|role| role.name == "Lower Rank 1")
            .expect("lower-ranked role")
            .clone();
        let (_, owner_session) = context.account_from_user(owner.id.clone()).await;

        let response = context
            .client
            .patch(format!("/servers/{}/roles/{}", server.id, role.id))
            .header(ContentType::JSON)
            .body(
                json!(v0::DataEditRole {
                    name: Some("Audited Role".to_string()),
                    colour: Some("#ff00aa".to_string()),
                    hoist: Some(true),
                    mentionable: Some(false),
                    rank: None,
                    icon: None,
                    remove: vec![],
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
                    action: Some(ServerAuditLogAction::RoleUpdate),
                    limit: 50,
                    ..Default::default()
                },
            )
            .await
            .expect("audit entries fetched");

        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.actor_id, owner.id);
        assert_eq!(entry.status, ServerAuditLogStatus::Succeeded);
        assert_eq!(
            entry.target,
            ServerAuditLogTarget::Role {
                id: role.id.clone()
            }
        );
        assert_eq!(entry.changes["name"].before, Some(json!("Lower Rank 1")));
        assert_eq!(entry.changes["name"].after, Some(json!("Audited Role")));
        assert_eq!(entry.changes["colour"].before, None);
        assert_eq!(entry.changes["colour"].after, Some(json!("#ff00aa")));
        assert_eq!(entry.changes["hoist"].before, Some(json!(false)));
        assert_eq!(entry.changes["hoist"].after, Some(json!(true)));
        assert_eq!(entry.changes["mentionable"].before, Some(json!(true)));
        assert_eq!(entry.changes["mentionable"].after, Some(json!(false)));
    }

    #[rocket::async_test]
    async fn failed_role_edit_marks_audit_entry_failed() {
        let context = RoleEditTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            owner user 0
            server server 4);

        let role = server
            .roles
            .values()
            .find(|role| role.name == "Lower Rank 1")
            .expect("lower-ranked role")
            .clone();
        let missing_icon_id = "01ARZ3NDEKTSV4RRFFQ69G5FAV".to_string();
        let (_, owner_session) = context.account_from_user(owner.id.clone()).await;

        let response = context
            .client
            .patch(format!("/servers/{}/roles/{}", server.id, role.id))
            .header(ContentType::JSON)
            .body(
                json!(v0::DataEditRole {
                    name: None,
                    colour: None,
                    hoist: None,
                    mentionable: None,
                    rank: None,
                    icon: Some(missing_icon_id.clone()),
                    remove: vec![],
                })
                .to_string(),
            )
            .header(Header::new(
                "x-session-token",
                owner_session.token.to_string(),
            ))
            .dispatch()
            .await;

        assert_ne!(response.status(), Status::Ok);
        drop(response);

        let entries = context
            .db
            .fetch_server_audit_logs(
                &server.id,
                ServerAuditLogQuery {
                    action: Some(ServerAuditLogAction::RoleUpdate),
                    limit: 50,
                    ..Default::default()
                },
            )
            .await
            .expect("audit entries fetched");

        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.actor_id, owner.id);
        assert_eq!(entry.status, ServerAuditLogStatus::Failed);
        assert!(entry.error.is_some());
        assert_eq!(
            entry.target,
            ServerAuditLogTarget::Role {
                id: role.id.clone()
            }
        );
        assert_eq!(entry.changes["icon"].before, None);
        assert_eq!(entry.changes["icon"].after, Some(json!(missing_icon_id)));
    }

    #[rocket::async_test]
    async fn edit_role_rejects_setting_and_removing_colour() {
        let context = RoleEditTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            owner user 0
            server server 4);

        let role = server
            .roles
            .values()
            .find(|role| role.name == "Lower Rank 1")
            .expect("lower-ranked role")
            .clone();
        let (_, owner_session) = context.account_from_user(owner.id.clone()).await;

        let response = context
            .client
            .patch(format!("/servers/{}/roles/{}", server.id, role.id))
            .header(ContentType::JSON)
            .body(
                json!(v0::DataEditRole {
                    name: None,
                    colour: Some("#ff00aa".to_string()),
                    hoist: None,
                    mentionable: None,
                    rank: None,
                    icon: None,
                    remove: vec![v0::FieldsRole::Colour],
                })
                .to_string(),
            )
            .header(Header::new(
                "x-session-token",
                owner_session.token.to_string(),
            ))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::BadRequest);
        drop(response);

        let entries = context
            .db
            .fetch_server_audit_logs(
                &server.id,
                ServerAuditLogQuery {
                    action: Some(ServerAuditLogAction::RoleUpdate),
                    limit: 50,
                    ..Default::default()
                },
            )
            .await
            .expect("audit entries fetched");

        assert!(entries.is_empty());
    }

    #[rocket::async_test]
    async fn edit_role_metadata_does_not_require_voice_sync() {
        let context = RoleEditTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            owner user 0
            server server 4);

        let voice_channel_id = Ulid::new().to_string();
        let voice_channel = Channel::TextChannel {
            id: voice_channel_id.clone(),
            server: server.id.clone(),
            name: "Voice".to_string(),
            description: None,
            icon: None,
            last_message_id: None,
            default_permissions: None,
            role_permissions: Default::default(),
            user_permissions: Default::default(),
            nsfw: false,
            voice: Some(VoiceInformation::default()),
            slowmode: None,
        };
        context
            .db
            .insert_channel(&voice_channel)
            .await
            .expect("voice channel inserted");
        context
            .db
            .update_server(
                &server.id,
                &PartialServer {
                    channels: Some(vec![voice_channel_id]),
                    ..Default::default()
                },
                vec![],
            )
            .await
            .expect("server voice channel linked");

        let role = server
            .roles
            .values()
            .find(|role| role.name == "Lower Rank 1")
            .expect("lower-ranked role")
            .clone();
        let (_, owner_session) = context.account_from_user(owner.id.clone()).await;

        let response = context
            .client
            .patch(format!("/servers/{}/roles/{}", server.id, role.id))
            .header(ContentType::JSON)
            .body(
                json!(v0::DataEditRole {
                    name: Some("Renamed Voice Metadata".to_string()),
                    colour: None,
                    hoist: None,
                    mentionable: None,
                    rank: None,
                    icon: None,
                    remove: vec![],
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

        let updated = context
            .db
            .fetch_server(&server.id)
            .await
            .expect("server fetched")
            .roles
            .get(&role.id)
            .expect("role still exists")
            .clone();

        assert_eq!(updated.name, "Renamed Voice Metadata");
        assert_eq!(updated.permissions, OverrideField::default());
    }
}
