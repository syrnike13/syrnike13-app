use iso8601_timestamp::Timestamp;
use rocket::serde::json::Json;
use rocket::State;
use syrnike_database::{Badge, Database, FieldsBadge, File, PartialBadge, User};
use syrnike_models::v0;
use syrnike_result::{create_error, Result};
use validator::Validate;

use super::require_privileged;

#[openapi(tag = "Admin")]
#[get("/badges")]
pub async fn list(db: &State<Database>, user: User) -> Result<Json<Vec<v0::Badge>>> {
    require_privileged(&user)?;

    Ok(Json(
        db.fetch_badges()
            .await?
            .into_iter()
            .map(Into::into)
            .collect(),
    ))
}

#[openapi(tag = "Admin")]
#[post("/badges", data = "<data>")]
pub async fn create(
    db: &State<Database>,
    user: User,
    data: Json<v0::DataCreateBadge>,
) -> Result<Json<v0::Badge>> {
    require_privileged(&user)?;

    let data = data.into_inner();
    data.validate().map_err(|error| {
        create_error!(FailedValidation {
            error: error.to_string()
        })
    })?;

    if db.fetch_badge_by_slug(&data.slug).await.is_ok() {
        return Err(create_error!(FailedValidation {
            error: "badge slug already exists".to_string()
        }));
    }

    let mut badge = Badge::new(
        data.slug,
        data.name,
        data.description,
        None,
        data.visible,
        data.premium,
        data.display_order,
    );

    if let Some(icon_file_id) = data.icon_file_id {
        badge.icon = Some(File::use_badge_icon(db, &icon_file_id, &badge.id, &user.id).await?);
    }

    db.insert_badge(&badge).await?;

    Ok(Json(badge.into()))
}

#[openapi(tag = "Admin")]
#[patch("/badges/<badge_id>", data = "<data>")]
pub async fn edit(
    db: &State<Database>,
    user: User,
    badge_id: String,
    data: Json<v0::DataEditBadge>,
) -> Result<Json<v0::Badge>> {
    require_privileged(&user)?;

    let data = data.into_inner();
    data.validate().map_err(|error| {
        create_error!(FailedValidation {
            error: error.to_string()
        })
    })?;

    let current = db.fetch_badge(&badge_id).await?;
    if let Some(slug) = &data.slug {
        if let Ok(existing) = db.fetch_badge_by_slug(slug).await {
            if existing.id != badge_id {
                return Err(create_error!(FailedValidation {
                    error: "badge slug already exists".to_string()
                }));
            }
        }
    }

    let old_icon_id = current.icon.as_ref().map(|icon| icon.id.clone());
    let mut remove = data
        .remove
        .into_iter()
        .map(FieldsBadge::from)
        .collect::<Vec<_>>();
    let next_icon = if let Some(icon_file_id) = data.icon_file_id {
        Some(File::use_badge_icon(db, &icon_file_id, &badge_id, &user.id).await?)
    } else {
        None
    };
    let replacing_icon = next_icon.is_some();

    if replacing_icon {
        remove.retain(|field| field != &FieldsBadge::Icon);
    }

    let partial = PartialBadge {
        slug: data.slug,
        name: data.name,
        description: data.description,
        icon: next_icon,
        visible: data.visible,
        premium: data.premium,
        display_order: data.display_order,
        updated_at: Some(Timestamp::now_utc()),
        ..Default::default()
    };

    db.update_badge(&badge_id, &partial, &remove).await?;

    if let Some(old_icon_id) = old_icon_id {
        let icon_removed = remove.contains(&FieldsBadge::Icon);
        let icon_replaced = partial
            .icon
            .as_ref()
            .is_some_and(|new_icon| old_icon_id != new_icon.id);

        if icon_removed || icon_replaced {
            db.mark_attachment_as_deleted(&old_icon_id).await?;
        }
    }

    Ok(Json(db.fetch_badge(&badge_id).await?.into()))
}

#[openapi(tag = "Admin")]
#[delete("/badges/<badge_id>")]
pub async fn delete(db: &State<Database>, user: User, badge_id: String) -> Result<()> {
    require_privileged(&user)?;

    let badge = db.fetch_badge(&badge_id).await?;

    db.delete_badge_assignments(&badge_id).await?;
    db.delete_badge(&badge_id).await?;

    if let Some(icon) = badge.icon {
        db.mark_attachment_as_deleted(&icon.id).await?;
    }

    Ok(())
}
