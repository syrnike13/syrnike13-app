use std::collections::HashSet;

use authifier::models::{totp::Totp, Account, ValidatedTicket};
use syrnike_database::{
    util::{permissions::DatabasePermissionQuery, reference::Reference},
    Database, File, PartialServer, User,
};
use syrnike_models::v0;
use syrnike_permissions::{calculate_server_permissions, ChannelPermission};
use syrnike_result::{create_error, Result};
use rocket::{serde::json::Json, Request, State};
use validator::Validate;

pub(crate) fn validate_server_channel_order(
    current: &[String],
    next: &[String],
) -> Result<()> {
    if next.len() != current.len() {
        return Err(create_error!(InvalidOperation));
    }

    let mut seen = HashSet::new();
    for channel in next {
        if !current.contains(channel) || !seen.insert(channel.clone()) {
            return Err(create_error!(InvalidOperation));
        }
    }

    Ok(())
}

/// # Edit Server
///
/// Edit a server by its id.
#[openapi(tag = "Server Information")]
#[patch("/<target>", data = "<data>")]
pub async fn edit(
    db: &State<Database>,
    account: Account,
    user: User,
    target: Reference<'_>,
    data: Json<v0::DataEditServer>,
    validated_ticket: Option<ValidatedTicket>,
) -> Result<Json<v0::Server>> {
    let data = data.into_inner();
    data.validate().map_err(|error| {
        create_error!(FailedValidation {
            error: error.to_string()
        })
    })?;

    let mut server = target.as_server(db).await?;
    let mut query = DatabasePermissionQuery::new(db, &user).server(&server);
    let permissions = calculate_server_permissions(&mut query).await;

    // Check permissions
    if data.name.is_none()
        && data.description.is_none()
        && data.icon.is_none()
        && data.banner.is_none()
        && data.system_messages.is_none()
        && data.categories.is_none()
        && data.channels.is_none()
        // && data.nsfw.is_none()
        && data.flags.is_none()
        && data.analytics.is_none()
        && data.discoverable.is_none()
        && data.owner.is_none()
        && data.remove.is_empty()
    {
        return Ok(Json(server.into()));
    } else if data.name.is_some()
        || data.description.is_some()
        || data.icon.is_some()
        || data.banner.is_some()
        || data.system_messages.is_some()
        || data.analytics.is_some()
        || !data.remove.is_empty()
    {
        permissions.throw_if_lacking_channel_permission(ChannelPermission::ManageServer)?;
    }

    // Check we are the server owner or privileged if changing sensitive fields
    if data.owner.is_some() {
        if user.id != server.owner && !user.privileged {
            return Err(create_error!(NotOwner));
        }

        if validated_ticket.is_none() {
            return Err(create_error!(InvalidCredentials));
        }
    }

    // Check we are privileged if changing sensitive fields
    if (data.flags.is_some() /*|| data.nsfw.is_some()*/ || data.discoverable.is_some())
        && !user.privileged
    {
        return Err(create_error!(NotPrivileged));
    }

    // Changing categories or channel order requires manage channel
    if data.categories.is_some() || data.channels.is_some() {
        permissions.throw_if_lacking_channel_permission(ChannelPermission::ManageChannel)?;
    }

    let v0::DataEditServer {
        name,
        description,
        icon,
        banner,
        categories,
        channels,
        system_messages,
        flags,
        // nsfw,
        discoverable,
        analytics,
        owner,
        remove,
    } = data;

    let mut partial = PartialServer {
        name,
        description,
        categories: categories.map(|v| v.into_iter().map(Into::into).collect()),
        channels,
        system_messages: system_messages.map(Into::into),
        flags,
        // nsfw,
        discoverable,
        analytics,
        owner: owner.clone(),
        ..Default::default()
    };

    // 1. Remove fields from object
    if remove.contains(&v0::FieldsServer::Banner) {
        if let Some(banner) = &server.banner {
            db.mark_attachment_as_deleted(&banner.id).await?;
        }
    }

    if remove.contains(&v0::FieldsServer::Icon) {
        if let Some(icon) = &server.icon {
            db.mark_attachment_as_deleted(&icon.id).await?;
        }
    }

    // 2. Validate changes
    if let Some(system_messages) = &partial.system_messages {
        for id in system_messages.clone().into_channel_ids() {
            if !server.channels.contains(&id) {
                return Err(create_error!(NotFound));
            }
        }
    }

    if let Some(categories) = &mut partial.categories {
        let mut channel_ids = HashSet::new();
        for category in categories {
            for channel in &category.channels {
                if channel_ids.contains(channel) {
                    return Err(create_error!(InvalidOperation));
                }

                channel_ids.insert(channel.to_string());
            }

            category
                .channels
                .retain(|item| server.channels.contains(item));
        }
    }

    if let Some(channels) = &partial.channels {
        validate_server_channel_order(&server.channels, channels)?;
    }

    // 3. Apply new icon
    if let Some(icon) = icon {
        partial.icon = Some(File::use_server_icon(db, &icon, &server.id, &user.id).await?);
        server.icon = partial.icon.clone();
    }

    // 4. Apply new banner
    if let Some(banner) = banner {
        partial.banner = Some(File::use_server_banner(db, &banner, &server.id, &user.id).await?);
        server.banner = partial.banner.clone();
    }

    // 5. Transfer ownership
    if let Some(owner) = owner {
        let owner_reference = Reference::from_unchecked(&owner);
        // Check if member exists
        owner_reference.as_member(db, &server.id).await?;
        let owner_user = owner_reference.as_user(db).await?;

        if owner_user.bot.is_some() {
            return Err(create_error!(InvalidOperation));
        }

        server.owner = owner;
        partial.owner = Some(server.owner.clone());
    }

    server
        .update(db, partial, remove.into_iter().map(Into::into).collect())
        .await?;

    Ok(Json(server.into()))
}

#[cfg(test)]
mod tests {
    use super::validate_server_channel_order;

    #[test]
    fn accepts_channel_reorder() {
        let current = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let next = vec!["c".to_string(), "a".to_string(), "b".to_string()];
        validate_server_channel_order(&current, &next).unwrap();
    }

    #[test]
    fn rejects_unknown_or_missing_channel_ids() {
        let current = vec!["a".to_string(), "b".to_string()];
        let next = vec!["a".to_string(), "c".to_string()];
        assert!(validate_server_channel_order(&current, &next).is_err());
    }

    #[test]
    fn rejects_duplicate_channel_ids() {
        let current = vec!["a".to_string(), "b".to_string()];
        let next = vec!["a".to_string(), "a".to_string()];
        assert!(validate_server_channel_order(&current, &next).is_err());
    }
}
