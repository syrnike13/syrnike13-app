use rocket::{State, serde::json::Json};
use syrnike_database::{
    Database, PartialServer, ServerAuditLogAction, ServerAuditLogTarget, User,
    util::{permissions::DatabasePermissionQuery, reference::Reference},
    voice::{VoiceClient, sync_voice_permissions},
};
use syrnike_models::v0;
use syrnike_permissions::{
    ChannelPermission, DataPermissionsValue, Override, calculate_server_permissions,
};
use syrnike_result::Result;

use super::audit_mutation;

/// # Set Default Permission
///
/// Sets permissions for the default role in this server.
#[openapi(tag = "Server Permissions")]
#[put("/<target>/permissions/default", data = "<data>", rank = 1)]
pub async fn set_default_server_permissions(
    db: &State<Database>,
    voice_client: &State<VoiceClient>,
    user: User,
    target: Reference<'_>,
    data: Json<DataPermissionsValue>,
) -> Result<Json<v0::Server>> {
    let data = data.into_inner();

    let mut server = target.as_server(db).await?;
    let mut query = DatabasePermissionQuery::new(db, &user).server(&server);
    let permissions = calculate_server_permissions(&mut query).await;

    permissions.throw_if_lacking_channel_permission(ChannelPermission::ManagePermissions)?;

    // Ensure we have permissions to grant these permissions forwards
    permissions
        .throw_permission_override(
            None,
            &Override {
                allow: data.permissions,
                deny: 0,
            },
        )
        .await?;

    let mut audit = audit_mutation::insert_pending_audit(
        db,
        server.id.clone(),
        user.id.clone(),
        ServerAuditLogAction::ServerPermissionUpdate,
        ServerAuditLogTarget::Server {
            id: server.id.clone(),
        },
        None,
        audit_mutation::audit_changes(vec![(
            "default_permissions",
            audit_mutation::audit_change(
                Some(server.default_permissions as u64),
                Some(data.permissions),
            )?,
        )]),
    )
    .await?;

    if let Err(error) = server
        .update(
            db,
            PartialServer {
                default_permissions: Some(data.permissions as i64),
                ..Default::default()
            },
            vec![],
        )
        .await
    {
        return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
    }

    for channel_id in &server.channels {
        let channel = match Reference::from_unchecked(channel_id).as_channel(db).await {
            Ok(channel) => channel,
            Err(error) => {
                return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
            }
        };

        if let Err(error) =
            sync_voice_permissions(db, voice_client, &channel, Some(&server), None).await
        {
            return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
        }
    }

    audit.mark_succeeded(db).await?;

    Ok(Json(server.into()))
}
