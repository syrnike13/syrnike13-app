use rocket::{serde::json::Json, State};
use syrnike_database::{
    util::{permissions::DatabasePermissionQuery, reference::Reference},
    voice::{delete_voice_channel, UserVoiceChannel, VoiceClient},
    Channel, Database, File, PartialChannel, ServerAuditLogAction, ServerAuditLogTarget,
    SystemMessage, User, AMQP,
};
use syrnike_models::v0;
use syrnike_permissions::{calculate_channel_permissions, ChannelPermission};
use syrnike_result::{create_error, Result};
use validator::Validate;

use crate::routes::servers::audit_mutation;

fn required_channel_edit_permission(data: &v0::DataEditChannel) -> ChannelPermission {
    if data.remove.contains(&v0::FieldsChannel::DefaultPermissions) {
        ChannelPermission::ManagePermissions
    } else {
        ChannelPermission::ManageChannel
    }
}

/// # Edit Channel
///
/// Edit a channel object by its id.
#[openapi(tag = "Channel Information")]
#[patch("/<target>", data = "<data>")]
pub async fn edit(
    db: &State<Database>,
    voice_client: &State<VoiceClient>,
    amqp: &State<AMQP>,
    user: User,
    target: Reference<'_>,
    data: Json<v0::DataEditChannel>,
) -> Result<Json<v0::Channel>> {
    let data = data.into_inner();
    data.validate().map_err(|error| {
        create_error!(FailedValidation {
            error: error.to_string()
        })
    })?;

    let mut channel = target.as_channel(db).await?;
    if channel.has_bot_recipient(db).await? {
        return Err(create_error!(NotFound));
    }

    let mut query = DatabasePermissionQuery::new(db, &user).channel(&channel);
    calculate_channel_permissions(&mut query)
        .await
        .throw_if_lacking_channel_permission(required_channel_edit_permission(&data))?;

    if data.name.is_none()
        && data.description.is_none()
        && data.icon.is_none()
        && data.nsfw.is_none()
        && data.owner.is_none()
        && data.voice.is_none()
        && data.slowmode.is_none()
        && data.remove.is_empty()
    {
        return Ok(Json(channel.into()));
    }

    let mut partial: PartialChannel = Default::default();
    let database_remove = data
        .remove
        .iter()
        .cloned()
        .map(Into::into)
        .collect::<Vec<_>>();
    let mut audit = match &channel {
        Channel::TextChannel {
            id,
            server,
            name,
            description,
            icon,
            nsfw,
            voice,
            slowmode,
            default_permissions,
            ..
        } => {
            let mut change_entries = Vec::new();
            if let Some(new_name) = data.name.clone() {
                change_entries.push((
                    "name",
                    audit_mutation::audit_change(Some(name.clone()), Some(new_name))?,
                ));
            }
            if data.remove.contains(&v0::FieldsChannel::Description) {
                change_entries.push((
                    "description",
                    audit_mutation::audit_change(description.clone(), None::<String>)?,
                ));
            } else if let Some(new_description) = data.description.clone() {
                change_entries.push((
                    "description",
                    audit_mutation::audit_change(description.clone(), Some(new_description))?,
                ));
            }
            if data.remove.contains(&v0::FieldsChannel::Icon) {
                change_entries.push((
                    "icon",
                    audit_mutation::audit_change(
                        icon.as_ref().map(|icon| icon.id.clone()),
                        None::<String>,
                    )?,
                ));
            } else if let Some(new_icon) = data.icon.clone() {
                change_entries.push((
                    "icon",
                    audit_mutation::audit_change(
                        icon.as_ref().map(|icon| icon.id.clone()),
                        Some(new_icon),
                    )?,
                ));
            }
            if let Some(new_nsfw) = data.nsfw {
                change_entries.push((
                    "nsfw",
                    audit_mutation::audit_change(Some(*nsfw), Some(new_nsfw))?,
                ));
            }
            if data.remove.contains(&v0::FieldsChannel::Voice) {
                change_entries.push((
                    "voice",
                    audit_mutation::audit_change(
                        voice.as_ref().map(|voice| serde_json::json!(voice)),
                        None::<serde_json::Value>,
                    )?,
                ));
            } else if let Some(new_voice) = &data.voice {
                change_entries.push((
                    "voice",
                    audit_mutation::audit_change(
                        voice.as_ref().map(|voice| serde_json::json!(voice)),
                        Some(serde_json::json!(new_voice)),
                    )?,
                ));
            }
            if data.remove.contains(&v0::FieldsChannel::DefaultPermissions) {
                change_entries.push((
                    "default_permissions",
                    audit_mutation::audit_change(*default_permissions, None::<_>)?,
                ));
            }
            if let Some(new_slowmode) = data.slowmode {
                change_entries.push((
                    "slowmode",
                    audit_mutation::audit_change(*slowmode, Some(new_slowmode))?,
                ));
            }

            Some(
                audit_mutation::insert_pending_audit(
                    db,
                    server.clone(),
                    user.id.clone(),
                    ServerAuditLogAction::ChannelUpdate,
                    ServerAuditLogTarget::Channel { id: id.clone() },
                    None,
                    audit_mutation::audit_changes(change_entries),
                )
                .await?,
            )
        }
        _ => None,
    };

    // Transfer group ownership
    if let Some(new_owner) = data.owner {
        if let Channel::Group {
            owner, recipients, ..
        } = &mut channel
        {
            // Make sure we are the owner of this group
            if owner != &user.id {
                return Err(create_error!(NotOwner));
            }

            // Ensure user is part of group
            if !recipients.contains(&new_owner) {
                return Err(create_error!(NotInGroup));
            }

            // Transfer ownership
            partial.owner = Some(new_owner.to_string());
            let old_owner = std::mem::replace(owner, new_owner.to_string());

            // Notify clients
            SystemMessage::ChannelOwnershipChanged {
                from: old_owner,
                to: new_owner,
            }
        } else {
            let error = create_error!(InvalidOperation);
            if let Some(audit) = &mut audit {
                return audit_mutation::mark_failed_and_return(db, audit, error).await;
            }

            return Err(error);
        }
        .into_message(channel.id().to_string())
        .send(
            db,
            Some(amqp),
            user.as_author_for_system(),
            None,
            None,
            &channel,
            false,
        )
        .await
        .ok();
    }

    match &mut channel {
        Channel::Group {
            id,
            name,
            description,
            icon,
            nsfw,
            ..
        } => {
            if data.remove.contains(&v0::FieldsChannel::Icon) {
                if let Some(icon) = &icon {
                    if let Err(error) = db.mark_attachment_as_deleted(&icon.id).await {
                        if let Some(audit) = &mut audit {
                            return audit_mutation::mark_failed_and_return(db, audit, error).await;
                        }

                        return Err(error);
                    }
                }
            }

            for field in &data.remove {
                match field {
                    v0::FieldsChannel::Description => {
                        description.take();
                    }
                    v0::FieldsChannel::Icon => {
                        icon.take();
                    }
                    _ => {}
                }
            }

            if let Some(icon_id) = data.icon {
                partial.icon = match File::use_channel_icon(db, &icon_id, id, &user.id).await {
                    Ok(icon) => Some(icon),
                    Err(error) => {
                        if let Some(audit) = &mut audit {
                            return audit_mutation::mark_failed_and_return(db, audit, error).await;
                        }

                        return Err(error);
                    }
                };
                *icon = partial.icon.clone();
            }

            if let Some(new_name) = data.name {
                *name = new_name.clone();
                partial.name = Some(new_name);
            }

            if let Some(new_description) = data.description {
                partial.description = Some(new_description);
                *description = partial.description.clone();
            }

            if let Some(new_nsfw) = data.nsfw {
                *nsfw = new_nsfw;
                partial.nsfw = Some(new_nsfw);
            }

            // Send out mutation system messages.
            if let Some(name) = &partial.name {
                SystemMessage::ChannelRenamed {
                    name: name.to_string(),
                    by: user.id.clone(),
                }
                .into_message(channel.id().to_string())
                .send(
                    db,
                    Some(amqp),
                    user.as_author_for_system(),
                    None,
                    None,
                    &channel,
                    false,
                )
                .await
                .ok();
            }

            if partial.description.is_some() {
                SystemMessage::ChannelDescriptionChanged {
                    by: user.id.clone(),
                }
                .into_message(channel.id().to_string())
                .send(
                    db,
                    Some(amqp),
                    user.as_author_for_system(),
                    None,
                    None,
                    &channel,
                    false,
                )
                .await
                .ok();
            }

            if partial.icon.is_some() {
                SystemMessage::ChannelIconChanged {
                    by: user.id.clone(),
                }
                .into_message(channel.id().to_string())
                .send(
                    db,
                    Some(amqp),
                    user.as_author_for_system(),
                    None,
                    None,
                    &channel,
                    false,
                )
                .await
                .ok();
            }
        }
        Channel::TextChannel {
            id,
            name,
            description,
            icon,
            nsfw,
            voice,
            slowmode,
            ..
        } => {
            if data.remove.contains(&v0::FieldsChannel::Icon) {
                if let Some(icon) = &icon {
                    if let Err(error) = db.mark_attachment_as_deleted(&icon.id).await {
                        if let Some(audit) = &mut audit {
                            return audit_mutation::mark_failed_and_return(db, audit, error).await;
                        }

                        return Err(error);
                    }
                }
            }

            for field in &data.remove {
                match field {
                    v0::FieldsChannel::Description => {
                        description.take();
                    }
                    v0::FieldsChannel::Icon => {
                        icon.take();
                    }
                    v0::FieldsChannel::Voice => {
                        voice.take();
                    }
                    _ => {}
                }
            }

            if let Some(icon_id) = data.icon {
                partial.icon = match File::use_channel_icon(db, &icon_id, id, &user.id).await {
                    Ok(icon) => Some(icon),
                    Err(error) => {
                        if let Some(audit) = &mut audit {
                            return audit_mutation::mark_failed_and_return(db, audit, error).await;
                        }

                        return Err(error);
                    }
                };
                *icon = partial.icon.clone();
            }

            if let Some(new_name) = data.name {
                *name = new_name.clone();
                partial.name = Some(new_name);
            }

            if let Some(new_description) = data.description {
                partial.description = Some(new_description);
                *description = partial.description.clone();
            }

            if let Some(new_nsfw) = data.nsfw {
                *nsfw = new_nsfw;
                partial.nsfw = Some(new_nsfw);
            }

            if let Some(new_voice) = data.voice {
                *voice = Some(new_voice.clone().into());
                partial.voice = Some(new_voice.into());
            }

            if let Some(new_slowmode) = data.slowmode {
                *slowmode = Some(new_slowmode);
                partial.slowmode = Some(new_slowmode);
            }
        }
        _ => return Err(create_error!(InvalidOperation)),
    };

    if let Err(error) = channel.update(db, partial, database_remove).await {
        if let Some(audit) = &mut audit {
            return audit_mutation::mark_failed_and_return(db, audit, error).await;
        }

        return Err(error);
    }

    if channel.voice().is_none() {
        if let Err(error) =
            delete_voice_channel(voice_client, &UserVoiceChannel::from_channel(&channel)).await
        {
            if let Some(audit) = &mut audit {
                return audit_mutation::mark_failed_and_return(db, audit, error).await;
            }

            return Err(error);
        }
    }

    if let Some(audit) = &mut audit {
        audit.mark_succeeded(db).await?;
    }

    Ok(Json(channel.into()))
}

#[cfg(test)]
mod tests {
    use syrnike_models::v0;
    use syrnike_permissions::ChannelPermission;

    fn edit_payload(remove: Vec<v0::FieldsChannel>) -> v0::DataEditChannel {
        v0::DataEditChannel {
            name: None,
            description: None,
            owner: None,
            icon: None,
            nsfw: None,
            archived: None,
            voice: None,
            slowmode: None,
            remove,
        }
    }

    #[test]
    fn removing_default_permissions_requires_manage_permissions() {
        assert_eq!(
            super::required_channel_edit_permission(&edit_payload(vec![
                v0::FieldsChannel::DefaultPermissions
            ])),
            ChannelPermission::ManagePermissions
        );
    }

    #[test]
    fn ordinary_channel_edits_require_manage_channel() {
        let mut payload = edit_payload(Vec::new());
        payload.name = Some("renamed".to_string());

        assert_eq!(
            super::required_channel_edit_permission(&payload),
            ChannelPermission::ManageChannel
        );
    }
}
