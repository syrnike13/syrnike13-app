use rocket::State;
use rocket_empty::EmptyResponse;
use syrnike_database::{
    Database, Role, ServerAuditLogAction, ServerAuditLogTarget, User,
    util::{permissions::DatabasePermissionQuery, reference::Reference},
    voice::{VoiceClient, sync_voice_permissions},
};
use syrnike_permissions::{ChannelPermission, calculate_server_permissions};
use syrnike_result::{Result, create_error};

use super::audit_mutation;

/// # Delete Role
///
/// Delete a server role by its id.
#[openapi(tag = "Server Permissions")]
#[delete("/<target>/roles/<role_id>")]
pub async fn delete(
    db: &State<Database>,
    user: User,
    target: Reference<'_>,
    role_id: String,
    voice_client: &State<VoiceClient>,
) -> Result<EmptyResponse> {
    let mut server = target.as_server(db).await?;
    let mut query = DatabasePermissionQuery::new(db, &user).server(&server);
    calculate_server_permissions(&mut query)
        .await
        .throw_if_lacking_channel_permission(ChannelPermission::ManageRole)?;

    let member_rank = query.get_member_rank().unwrap_or(i64::MIN);

    let role = server
        .roles
        .remove(&role_id)
        .ok_or_else(|| create_error!(NotFound))?;

    if role.rank <= member_rank {
        return Err(create_error!(NotElevated));
    }

    let mut audit = audit_mutation::insert_pending_audit(
        db,
        server.id.clone(),
        user.id.clone(),
        ServerAuditLogAction::RoleDelete,
        ServerAuditLogTarget::Role {
            id: role.id.clone(),
        },
        None,
        audit_mutation::audit_changes(vec![(
            "role",
            audit_mutation::audit_change(Some(role.clone()), None::<Role>)?,
        )]),
    )
    .await?;

    if let Err(error) = role.delete(db, &server.id).await {
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

    Ok(EmptyResponse)
}
