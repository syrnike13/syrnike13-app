use base64::{engine::general_purpose::STANDARD, Engine as _};
use rocket::serde::json::Json;
use rocket::State;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use syrnike_config::config;
use syrnike_database::{Database, DiagnosticReport, DiagnosticReportStatus, User};
use syrnike_files::{delete_from_s3, upload_to_s3};
use syrnike_result::{create_error, Result};
use ulid::Ulid;

const MAX_COMPRESSED_BYTES: usize = 10 * 1024 * 1024;
const RETENTION_SECONDS: u64 = 30 * 24 * 60 * 60;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticReportUpload {
    pub version: u8,
    pub source: String,
    pub release_channel: String,
    pub app_version: String,
    pub platform: String,
    pub area: String,
    pub severity: String,
    pub trigger_code: String,
    #[serde(default)]
    pub description: String,
    /// A gzip-compressed JSONL diagnostic bundle encoded as base64.
    pub payload: String,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct DiagnosticReportCreated {
    pub id: String,
    pub created_at: u64,
}

#[openapi(tag = "Core")]
#[post("/reports", format = "json", data = "<data>")]
pub async fn create_report(
    db: &State<Database>,
    user: User,
    data: Json<DiagnosticReportUpload>,
) -> Result<Json<DiagnosticReportCreated>> {
    let data = data.into_inner();
    validate_upload(&data)?;

    let payload = STANDARD
        .decode(&data.payload)
        .map_err(|_| validation("payload is not valid base64"))?;
    if payload.is_empty() || payload.len() > MAX_COMPRESSED_BYTES {
        return Err(validation("diagnostic payload size is invalid"));
    }
    if !payload.starts_with(&[0x1f, 0x8b]) {
        return Err(validation("diagnostic payload must be gzip compressed"));
    }

    let id = Ulid::new().to_string();
    let created_at = chrono::Utc::now().timestamp().max(0) as u64;
    let bucket_id = config().await.files.s3.default_bucket;
    let object_key = format!(
        "diagnostics/{}/{}/{}.jsonl.gz",
        chrono::Utc::now().format("%Y"),
        chrono::Utc::now().format("%m"),
        id
    );
    let sha256 = format!("{:x}", Sha256::digest(&payload));
    let encryption_iv = upload_to_s3(&bucket_id, &object_key, &payload).await?;
    let report = DiagnosticReport {
        id: id.clone(),
        user_id: user.id.clone(),
        created_at,
        expires_at: created_at + RETENTION_SECONDS,
        source: data.source,
        release_channel: data.release_channel,
        app_version: data.app_version,
        platform: data.platform,
        area: data.area,
        severity: data.severity,
        trigger_code: data.trigger_code,
        description: data.description,
        bucket_id: bucket_id.clone(),
        object_key: object_key.clone(),
        encryption_iv,
        size_bytes: payload.len() as u64,
        sha256,
        status: DiagnosticReportStatus::New,
        notes: String::new(),
    };

    if let Err(error) = db.insert_diagnostic_report(&report).await {
        let _ = delete_from_s3(&bucket_id, &object_key).await;
        return Err(error);
    }

    Ok(Json(DiagnosticReportCreated { id, created_at }))
}

fn validate_upload(data: &DiagnosticReportUpload) -> Result<()> {
    if data.version != 1 {
        return Err(validation("unsupported diagnostic report version"));
    }
    validate_enum("source", &data.source, &["web", "desktop"])?;
    validate_enum(
        "release_channel",
        &data.release_channel,
        &["stable", "nightly", "development"],
    )?;
    validate_enum("severity", &data.severity, &["warning", "error", "fatal"])?;
    validate_text("app_version", &data.app_version, 64)?;
    validate_text("platform", &data.platform, 64)?;
    validate_text("area", &data.area, 64)?;
    validate_text("trigger_code", &data.trigger_code, 128)?;
    if data.description.len() > 1_000 {
        return Err(validation("description is too long"));
    }
    Ok(())
}

fn validate_enum(field: &str, value: &str, allowed: &[&str]) -> Result<()> {
    if allowed.contains(&value) {
        Ok(())
    } else {
        Err(validation(&format!("invalid {field}")))
    }
}

fn validate_text(field: &str, value: &str, max: usize) -> Result<()> {
    if !value.is_empty()
        && value.len() <= max
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
    {
        Ok(())
    } else {
        Err(validation(&format!("invalid {field}")))
    }
}

fn validation(message: &str) -> syrnike_result::Error {
    create_error!(FailedValidation {
        error: message.to_owned()
    })
}

pub fn routes() -> (Vec<rocket::Route>, revolt_okapi::openapi3::OpenApi) {
    openapi_get_routes_spec![create_report]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn upload() -> DiagnosticReportUpload {
        DiagnosticReportUpload {
            version: 1,
            source: "desktop".into(),
            release_channel: "nightly".into(),
            app_version: "0.5.1".into(),
            platform: "win32".into(),
            area: "voice".into(),
            severity: "error".into(),
            trigger_code: "screen_start_failed".into(),
            description: String::new(),
            payload: String::new(),
        }
    }

    #[test]
    fn accepts_allowlisted_metadata() {
        assert!(validate_upload(&upload()).is_ok());
    }

    #[test]
    fn rejects_unbounded_or_unknown_metadata() {
        let mut value = upload();
        value.area = "voice/private/path".into();
        assert!(validate_upload(&value).is_err());
    }
}
