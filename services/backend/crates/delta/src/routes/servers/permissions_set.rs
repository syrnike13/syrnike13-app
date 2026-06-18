use rocket::{State, serde::json::Json};
use syrnike_database::{
    Database, ServerAuditLogAction, ServerAuditLogTarget, User,
    util::{permissions::DatabasePermissionQuery, reference::Reference},
    voice::{VoiceClient, sync_voice_permissions},
};
use syrnike_models::v0;
use syrnike_permissions::{ChannelPermission, Override, calculate_server_permissions};
use syrnike_result::{Result, create_error};

use super::audit_mutation;

/// # Set Role Permission
///
/// Sets permissions for the specified role in the server.
#[openapi(tag = "Server Permissions")]
#[put("/<target>/permissions/<role_id>", data = "<data>", rank = 2)]
pub async fn set_role_permission(
    db: &State<Database>,
    voice_client: &State<VoiceClient>,
    user: User,
    target: Reference<'_>,
    role_id: String,
    data: Json<v0::DataSetServerRolePermission>,
) -> Result<Json<v0::Server>> {
    let data = data.into_inner();

    let mut server = target.as_server(db).await?;

    let (current_value, rank) = server
        .roles
        .get(&role_id)
        .map(|x| (x.permissions, x.rank))
        .ok_or_else(|| create_error!(NotFound))?;

    let mut query = DatabasePermissionQuery::new(db, &user).server(&server);
    let permissions = calculate_server_permissions(&mut query).await;

    permissions.throw_if_lacking_channel_permission(ChannelPermission::ManagePermissions)?;

    // Prevent us from editing roles above us
    if rank <= query.get_member_rank().unwrap_or(i64::MIN) {
        return Err(create_error!(NotElevated));
    }

    // Ensure we have access to grant these permissions forwards
    let current_value: Override = current_value.into();
    let requested_permissions = data.permissions.clone();
    permissions
        .throw_permission_override(current_value.clone(), &requested_permissions)
        .await?;

    let mut audit = audit_mutation::insert_pending_audit(
        db,
        server.id.clone(),
        user.id.clone(),
        ServerAuditLogAction::ServerPermissionUpdate,
        ServerAuditLogTarget::Role {
            id: role_id.clone(),
        },
        None,
        audit_mutation::audit_changes(vec![(
            "permissions",
            audit_mutation::audit_change(Some(current_value), Some(requested_permissions.clone()))?,
        )]),
    )
    .await?;

    if let Err(error) = server
        .set_role_permission(db, &role_id, requested_permissions.into())
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
            sync_voice_permissions(db, voice_client, &channel, Some(&server), Some(&role_id)).await
        {
            return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
        }
    }

    audit.mark_succeeded(db).await?;

    Ok(Json(server.into()))
}
