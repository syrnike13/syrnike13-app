use std::collections::{HashMap, HashSet};

use authifier::models::{Account, ValidatedTicket};
use rocket::{serde::json::Json, State};
use syrnike_database::{
    util::{permissions::DatabasePermissionQuery, reference::Reference},
    Database, File, PartialServer, Server, ServerAuditLogAction, ServerAuditLogChange,
    ServerAuditLogTarget, User,
};
use syrnike_models::v0;
use syrnike_permissions::{calculate_server_permissions, ChannelPermission};
use syrnike_result::{create_error, Result};
use validator::Validate;

use super::audit_mutation;

pub(crate) fn validate_server_channel_order(current: &[String], next: &[String]) -> Result<()> {
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

fn build_server_update_audit_changes(
    server: &Server,
    partial: &PartialServer,
    icon: Option<&str>,
    banner: Option<&str>,
    remove: &[v0::FieldsServer],
) -> Result<HashMap<String, ServerAuditLogChange>> {
    let mut change_entries = Vec::new();

    if let Some(new_name) = partial.name.clone() {
        change_entries.push((
            "name",
            audit_mutation::audit_change(Some(server.name.clone()), Some(new_name))?,
        ));
    }

    if let Some(new_description) = partial.description.clone() {
        change_entries.push((
            "description",
            audit_mutation::audit_change(server.description.clone(), Some(new_description))?,
        ));
    } else if remove.contains(&v0::FieldsServer::Description) {
        change_entries.push((
            "description",
            audit_mutation::audit_change(server.description.clone(), None::<String>)?,
        ));
    }

    if let Some(new_icon) = icon {
        change_entries.push((
            "icon",
            audit_mutation::audit_change(
                server.icon.as_ref().map(|icon| icon.id.clone()),
                Some(new_icon.to_string()),
            )?,
        ));
    } else if remove.contains(&v0::FieldsServer::Icon) {
        change_entries.push((
            "icon",
            audit_mutation::audit_change(
                server.icon.as_ref().map(|icon| icon.id.clone()),
                None::<String>,
            )?,
        ));
    }

    if let Some(new_banner) = banner {
        change_entries.push((
            "banner",
            audit_mutation::audit_change(
                server.banner.as_ref().map(|banner| banner.id.clone()),
                Some(new_banner.to_string()),
            )?,
        ));
    } else if remove.contains(&v0::FieldsServer::Banner) {
        change_entries.push((
            "banner",
            audit_mutation::audit_change(
                server.banner.as_ref().map(|banner| banner.id.clone()),
                None::<String>,
            )?,
        ));
    }

    if let Some(new_categories) = partial.categories.clone() {
        change_entries.push((
            "categories",
            audit_mutation::audit_change(server.categories.clone(), Some(new_categories))?,
        ));
    } else if remove.contains(&v0::FieldsServer::Categories) {
        change_entries.push((
            "categories",
            audit_mutation::audit_change(server.categories.clone(), None::<Vec<_>>)?,
        ));
    }

    if let Some(new_channels) = partial.channels.clone() {
        change_entries.push((
            "channels",
            audit_mutation::audit_change(Some(server.channels.clone()), Some(new_channels))?,
        ));
    }

    if let Some(new_system_messages) = partial.system_messages.clone() {
        change_entries.push((
            "system_messages",
            audit_mutation::audit_change(
                server.system_messages.clone(),
                Some(new_system_messages),
            )?,
        ));
    } else if remove.contains(&v0::FieldsServer::SystemMessages) {
        change_entries.push((
            "system_messages",
            audit_mutation::audit_change(server.system_messages.clone(), None::<_>)?,
        ));
    }

    if let Some(new_flags) = partial.flags {
        change_entries.push((
            "flags",
            audit_mutation::audit_change(server.flags, Some(new_flags))?,
        ));
    }

    if let Some(new_analytics) = partial.analytics {
        change_entries.push((
            "analytics",
            audit_mutation::audit_change(Some(server.analytics), Some(new_analytics))?,
        ));
    }

    if let Some(new_discoverable) = partial.discoverable {
        change_entries.push((
            "discoverable",
            audit_mutation::audit_change(Some(server.discoverable), Some(new_discoverable))?,
        ));
    }

    if let Some(new_owner) = partial.owner.clone() {
        change_entries.push((
            "owner",
            audit_mutation::audit_change(Some(server.owner.clone()), Some(new_owner))?,
        ));
    }

    Ok(audit_mutation::audit_changes(change_entries))
}

/// # Edit Server
///
/// Edit a server by its id.
#[openapi(tag = "Server Information")]
#[patch("/<target>", data = "<data>")]
pub async fn edit(
    db: &State<Database>,
    _account: Account,
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

    let conflicting_field = [
        (
            data.description.is_some(),
            v0::FieldsServer::Description,
            "description",
        ),
        (data.icon.is_some(), v0::FieldsServer::Icon, "icon"),
        (data.banner.is_some(), v0::FieldsServer::Banner, "banner"),
        (
            data.categories.is_some(),
            v0::FieldsServer::Categories,
            "categories",
        ),
        (
            data.system_messages.is_some(),
            v0::FieldsServer::SystemMessages,
            "system_messages",
        ),
    ]
    .iter()
    .find_map(|(is_set, field, name)| (*is_set && data.remove.contains(field)).then_some(*name));

    if let Some(field) = conflicting_field {
        return Err(create_error!(FailedValidation {
            error: format!("{field} cannot be set and removed in the same request")
        }));
    }

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

    // Only the server owner may transfer ownership. Project administration is a
    // separate scope and must not grant authority over user-owned servers.
    if data.owner.is_some() {
        if user.id != server.owner {
            return Err(create_error!(NotOwner));
        }

        if validated_ticket.is_none() {
            return Err(create_error!(InvalidCredentials));
        }
    }

    // Project administration must not expand the regular server API. Internal
    // server fields need a dedicated admin route if they are exposed again.
    if data.flags.is_some() /*|| data.nsfw.is_some()*/ || data.discoverable.is_some() {
        return Err(create_error!(InvalidOperation));
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

    // 1. Validate changes
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

    let changes = build_server_update_audit_changes(
        &server,
        &partial,
        icon.as_deref(),
        banner.as_deref(),
        &remove,
    )?;
    let mut audit = audit_mutation::insert_pending_audit(
        db,
        server.id.clone(),
        user.id.clone(),
        ServerAuditLogAction::ServerUpdate,
        ServerAuditLogTarget::Server {
            id: server.id.clone(),
        },
        None,
        changes,
    )
    .await?;

    // 2. Remove fields from object
    if remove.contains(&v0::FieldsServer::Banner) {
        if let Some(banner) = &server.banner {
            if let Err(error) = db.mark_attachment_as_deleted(&banner.id).await {
                return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
            }
        }
    }

    if remove.contains(&v0::FieldsServer::Icon) {
        if let Some(icon) = &server.icon {
            if let Err(error) = db.mark_attachment_as_deleted(&icon.id).await {
                return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
            }
        }
    }

    // 3. Apply new icon
    if let Some(icon) = icon {
        match File::use_server_icon(db, &icon, &server.id, &user.id).await {
            Ok(file) => {
                partial.icon = Some(file);
                server.icon = partial.icon.clone();
            }
            Err(error) => {
                return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
            }
        }
    }

    // 4. Apply new banner
    if let Some(banner) = banner {
        match File::use_server_banner(db, &banner, &server.id, &user.id).await {
            Ok(file) => {
                partial.banner = Some(file);
                server.banner = partial.banner.clone();
            }
            Err(error) => {
                return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
            }
        }
    }

    // 5. Transfer ownership
    if let Some(owner) = owner {
        let owner_reference = Reference::from_unchecked(&owner);
        // Check if member exists
        if let Err(error) = owner_reference.as_member(db, &server.id).await {
            return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
        }

        let owner_user = match owner_reference.as_user(db).await {
            Ok(user) => user,
            Err(error) => {
                return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
            }
        };

        if owner_user.bot.is_some() {
            return audit_mutation::mark_failed_and_return(
                db,
                &mut audit,
                create_error!(InvalidOperation),
            )
            .await;
        }

        server.owner = owner;
        partial.owner = Some(server.owner.clone());
    }

    if let Err(error) = server
        .update(db, partial, remove.into_iter().map(Into::into).collect())
        .await
    {
        return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
    }

    audit_mutation::mark_succeeded_after_commit(db, &mut audit).await;

    Ok(Json(server.into()))
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use syrnike_database::{PartialServer, Server};

    use super::{build_server_update_audit_changes, validate_server_channel_order};

    fn server_under_test() -> Server {
        Server {
            id: "server-1".to_string(),
            owner: "owner-1".to_string(),
            name: "Old Server".to_string(),
            description: Some("Old description".to_string()),
            channels: vec!["channel-1".to_string(), "channel-2".to_string()],
            categories: None,
            system_messages: None,
            roles: Default::default(),
            default_permissions: 0,
            icon: None,
            banner: None,
            flags: Some(1),
            nsfw: false,
            analytics: false,
            discoverable: false,
        }
    }

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

    #[test]
    fn builds_server_update_audit_changes_for_set_fields() {
        let server = server_under_test();
        let changes = build_server_update_audit_changes(
            &server,
            &PartialServer {
                name: Some("Renamed Server".to_string()),
                analytics: Some(true),
                flags: Some(2),
                ..Default::default()
            },
            None,
            None,
            &[],
        )
        .expect("audit changes built");

        assert_eq!(changes["name"].before, Some(json!("Old Server")));
        assert_eq!(changes["name"].after, Some(json!("Renamed Server")));
        assert_eq!(changes["analytics"].before, Some(json!(false)));
        assert_eq!(changes["analytics"].after, Some(json!(true)));
        assert_eq!(changes["flags"].before, Some(json!(1)));
        assert_eq!(changes["flags"].after, Some(json!(2)));
    }

    #[test]
    fn builds_server_update_audit_changes_for_removed_fields() {
        let server = server_under_test();
        let changes = build_server_update_audit_changes(
            &server,
            &PartialServer::default(),
            None,
            None,
            &[syrnike_models::v0::FieldsServer::Description],
        )
        .expect("audit changes built");

        assert_eq!(
            changes["description"].before,
            Some(json!("Old description"))
        );
        assert_eq!(changes["description"].after, None);
    }
}
