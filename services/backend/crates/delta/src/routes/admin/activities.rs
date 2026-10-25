use std::collections::HashSet;

use iso8601_timestamp::Timestamp;
use rocket::serde::json::Json;
use rocket::State;
use sha2::{Digest, Sha256};
use syrnike_database::{
    ActivityApplication, ActivityUrlMapping, Database, FieldsActivityApplication, File,
    PartialActivityApplication, User,
};
use syrnike_models::v0;
use syrnike_result::{create_error, Result};
use validator::Validate;

use super::require_privileged;

/// Application ids that would collide with `/activities/...` routes.
const RESERVED_APPLICATION_IDS: [&str; 2] = ["oauth", "applications"];

fn failed_validation(error: impl Into<String>) -> syrnike_result::Error {
    create_error!(FailedValidation {
        error: error.into()
    })
}

fn validate_http_url(field: &str, value: &str) -> Result<()> {
    match url::Url::parse(value) {
        Ok(url) if matches!(url.scheme(), "http" | "https") && url.host().is_some() => Ok(()),
        _ => Err(failed_validation(format!("{field} must be an http(s) URL"))),
    }
}

fn validate_url_mappings(mappings: &[v0::ActivityUrlMapping]) -> Result<()> {
    let mut prefixes = HashSet::new();
    for mapping in mappings {
        if !v0::RE_ACTIVITY_URL_MAPPING_PREFIX.is_match(&mapping.prefix) {
            return Err(failed_validation("invalid url mapping prefix"));
        }
        if !prefixes.insert(mapping.prefix.as_str()) {
            return Err(failed_validation("url mapping prefixes must be unique"));
        }
        validate_http_url("url mapping target", &mapping.target)?;
    }
    Ok(())
}

async fn activity_url_template() -> String {
    syrnike_config::config().await.hosts.activities
}

/// # List Activity Applications
///
/// Every registered application, enabled or not.
#[openapi(tag = "Admin")]
#[get("/activities")]
pub async fn list(
    db: &State<Database>,
    user: User,
) -> Result<Json<Vec<v0::AdminActivityApplication>>> {
    require_privileged(&user)?;

    let template = activity_url_template().await;
    let mut applications = db.fetch_activity_applications().await?;
    applications.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(Json(
        applications
            .into_iter()
            .map(|application| application.into_admin(&template))
            .collect(),
    ))
}

/// # Register Activity Application
#[openapi(tag = "Admin")]
#[post("/activities", data = "<data>")]
pub async fn create(
    db: &State<Database>,
    user: User,
    data: Json<v0::DataCreateActivityApplication>,
) -> Result<Json<v0::AdminActivityApplication>> {
    require_privileged(&user)?;

    let data = data.into_inner();
    data.validate()
        .map_err(|error| failed_validation(error.to_string()))?;
    if RESERVED_APPLICATION_IDS.contains(&data.id.as_str()) {
        return Err(failed_validation("activity application id is reserved"));
    }
    validate_http_url("origin_url", &data.origin_url)?;
    validate_url_mappings(&data.url_mappings)?;

    if db.fetch_activity_application(&data.id).await.is_ok() {
        return Err(failed_validation("activity application id already exists"));
    }

    let now = Timestamp::now_utc();
    let mut application = ActivityApplication {
        id: data.id,
        name: data.name,
        description: data.description,
        icon: None,
        origin_url: data.origin_url,
        url_mappings: data.url_mappings.into_iter().map(Into::into).collect(),
        max_participants: data.max_participants as i32,
        first_party: data.first_party,
        enabled: data.enabled,
        client_secret_hash: None,
        created_at: now,
        updated_at: now,
    };

    if let Some(icon_file_id) = data.icon_file_id {
        application.icon =
            Some(File::use_activity_icon(db, &icon_file_id, &application.id, &user.id).await?);
    }

    db.insert_activity_application(&application).await?;

    Ok(Json(application.into_admin(&activity_url_template().await)))
}

/// # Edit Activity Application
#[openapi(tag = "Admin")]
#[patch("/activities/<application_id>", data = "<data>")]
pub async fn edit(
    db: &State<Database>,
    user: User,
    application_id: String,
    data: Json<v0::DataEditActivityApplication>,
) -> Result<Json<v0::AdminActivityApplication>> {
    require_privileged(&user)?;

    let data = data.into_inner();
    data.validate()
        .map_err(|error| failed_validation(error.to_string()))?;
    if let Some(origin_url) = &data.origin_url {
        validate_http_url("origin_url", origin_url)?;
    }
    if let Some(url_mappings) = &data.url_mappings {
        validate_url_mappings(url_mappings)?;
    }

    let current = db.fetch_activity_application(&application_id).await?;
    let old_icon_id = current.icon.as_ref().map(|icon| icon.id.clone());

    let mut remove = data
        .remove
        .into_iter()
        .map(FieldsActivityApplication::from)
        .collect::<Vec<_>>();
    let next_icon = match data.icon_file_id {
        Some(icon_file_id) => {
            Some(File::use_activity_icon(db, &icon_file_id, &application_id, &user.id).await?)
        }
        None => None,
    };
    if next_icon.is_some() {
        remove.retain(|field| field != &FieldsActivityApplication::Icon);
    }

    let partial = PartialActivityApplication {
        name: data.name,
        description: data.description,
        icon: next_icon,
        origin_url: data.origin_url,
        url_mappings: data
            .url_mappings
            .map(|mappings| mappings.into_iter().map(ActivityUrlMapping::from).collect()),
        max_participants: data.max_participants.map(|value| value as i32),
        first_party: data.first_party,
        enabled: data.enabled,
        updated_at: Some(Timestamp::now_utc()),
        ..Default::default()
    };

    db.update_activity_application(&application_id, &partial, &remove)
        .await?;

    if let Some(old_icon_id) = old_icon_id {
        let icon_removed = remove.contains(&FieldsActivityApplication::Icon);
        let icon_replaced = partial
            .icon
            .as_ref()
            .is_some_and(|new_icon| old_icon_id != new_icon.id);
        if icon_removed || icon_replaced {
            db.mark_attachment_as_deleted(&old_icon_id).await?;
        }
    }

    Ok(Json(
        db.fetch_activity_application(&application_id)
            .await?
            .into_admin(&activity_url_template().await),
    ))
}

/// # Delete Activity Application
///
/// Running instances end within one reconcile interval.
#[openapi(tag = "Admin")]
#[delete("/activities/<application_id>")]
pub async fn delete(db: &State<Database>, user: User, application_id: String) -> Result<()> {
    require_privileged(&user)?;

    let application = db.fetch_activity_application(&application_id).await?;
    db.delete_activity_application(&application_id).await?;

    if let Some(icon) = application.icon {
        db.mark_attachment_as_deleted(&icon.id).await?;
    }

    Ok(())
}

/// # Generate Activity Client Secret
///
/// Replaces the client secret; the new secret is returned only once.
#[openapi(tag = "Admin")]
#[post("/activities/<application_id>/secret")]
pub async fn generate_secret(
    db: &State<Database>,
    user: User,
    application_id: String,
) -> Result<Json<v0::ActivityClientSecret>> {
    require_privileged(&user)?;

    db.fetch_activity_application(&application_id).await?;

    let client_secret = nanoid::nanoid!(64);
    let partial = PartialActivityApplication {
        client_secret_hash: Some(format!("{:x}", Sha256::digest(client_secret.as_bytes()))),
        updated_at: Some(Timestamp::now_utc()),
        ..Default::default()
    };
    db.update_activity_application(&application_id, &partial, &[])
        .await?;

    Ok(Json(v0::ActivityClientSecret { client_secret }))
}
