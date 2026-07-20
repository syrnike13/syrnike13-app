use base64::{engine::general_purpose::STANDARD, Engine as _};
use flate2::read::MultiGzDecoder;
use rocket::serde::json::Json;
use rocket::State;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::io::Read;
use syrnike_config::config;
use syrnike_database::{
    Database, DiagnosticReport, DiagnosticReportStatus, DiagnosticReportStorageState, User,
};
use syrnike_files::upload_to_s3;
use syrnike_result::{create_error, Result};
use ulid::Ulid;

const MAX_COMPRESSED_BYTES: usize = 10 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES: usize = 34 * 1024 * 1024;
const MAX_RECORD_BYTES: usize = 64 * 1024;
const MAX_RECORDS: usize = 100_000;
const RETENTION_SECONDS: u64 = 30 * 24 * 60 * 60;
const PENDING_RETENTION_SECONDS: u64 = 60 * 60;
const DIAGNOSTIC_SCHEMA: &str = "syrnike.diagnostic";

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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DiagnosticEnvelope {
    schema: String,
    version: u8,
    record_type: DiagnosticRecordType,
    timestamp_ms: u64,
    source: String,
    event: String,
    data: Map<String, Value>,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum DiagnosticRecordType {
    Manifest,
    Event,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DiagnosticManifestData {
    source: String,
    release_channel: String,
    app_version: String,
    platform: String,
    area: String,
    severity: String,
    trigger_code: String,
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
    validate_bundle(&payload, &data)?;

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
    let report = DiagnosticReport {
        id: id.clone(),
        user_id: user.id.clone(),
        created_at,
        expires_at: created_at + PENDING_RETENTION_SECONDS,
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
        encryption_iv: None,
        size_bytes: payload.len() as u64,
        sha256,
        storage_state: DiagnosticReportStorageState::Pending,
        status: DiagnosticReportStatus::New,
        notes: String::new(),
    };

    db.insert_diagnostic_report(&report).await?;
    let encryption_iv = upload_to_s3(&bucket_id, &object_key, &payload).await?;
    db.finalize_diagnostic_report(&id, encryption_iv, created_at + RETENTION_SECONDS)
        .await?;

    Ok(Json(DiagnosticReportCreated { id, created_at }))
}

fn validate_bundle(payload: &[u8], metadata: &DiagnosticReportUpload) -> Result<()> {
    let mut decoder = MultiGzDecoder::new(payload);
    let mut decompressed = Vec::new();
    decoder
        .by_ref()
        .take((MAX_DECOMPRESSED_BYTES + 1) as u64)
        .read_to_end(&mut decompressed)
        .map_err(|_| validation("diagnostic payload is not valid gzip"))?;
    if decompressed.len() > MAX_DECOMPRESSED_BYTES {
        return Err(validation("decompressed diagnostic payload is too large"));
    }
    let text = std::str::from_utf8(&decompressed)
        .map_err(|_| validation("diagnostic payload must be UTF-8 JSONL"))?;

    let mut manifest_seen = false;
    let mut record_count = 0;
    for (index, line) in text.lines().enumerate() {
        if line.is_empty() || line.len() > MAX_RECORD_BYTES {
            return Err(validation("diagnostic JSONL record size is invalid"));
        }
        record_count += 1;
        if record_count > MAX_RECORDS {
            return Err(validation("diagnostic payload contains too many records"));
        }
        let envelope: DiagnosticEnvelope = serde_json::from_str(line)
            .map_err(|_| validation("diagnostic payload contains an invalid envelope"))?;
        validate_envelope(&envelope)?;

        match envelope.record_type {
            DiagnosticRecordType::Manifest if index == 0 && !manifest_seen => {
                if envelope.event != "report_manifest" {
                    return Err(validation("diagnostic manifest event is invalid"));
                }
                let manifest: DiagnosticManifestData =
                    serde_json::from_value(Value::Object(envelope.data))
                        .map_err(|_| validation("diagnostic manifest is invalid"))?;
                validate_manifest(&manifest, metadata)?;
                manifest_seen = true;
            }
            DiagnosticRecordType::Manifest => {
                return Err(validation("diagnostic payload contains multiple manifests"));
            }
            DiagnosticRecordType::Event if index == 0 => {
                return Err(validation("diagnostic manifest must be the first record"));
            }
            DiagnosticRecordType::Event => {}
        }
    }
    if !manifest_seen {
        return Err(validation("diagnostic payload is missing a manifest"));
    }
    Ok(())
}

fn validate_envelope(envelope: &DiagnosticEnvelope) -> Result<()> {
    if envelope.schema != DIAGNOSTIC_SCHEMA || envelope.version != 1 {
        return Err(validation("unsupported diagnostic envelope schema"));
    }
    validate_enum(
        "diagnostic source",
        &envelope.source,
        &["web", "renderer", "electron-main", "utility", "native"],
    )?;
    validate_text("diagnostic event", &envelope.event, 256)?;
    let _ = envelope.timestamp_ms;
    Ok(())
}

fn validate_manifest(
    manifest: &DiagnosticManifestData,
    metadata: &DiagnosticReportUpload,
) -> Result<()> {
    if manifest.source != metadata.source
        || manifest.release_channel != metadata.release_channel
        || manifest.app_version != metadata.app_version
        || manifest.platform != metadata.platform
        || manifest.area != metadata.area
        || manifest.severity != metadata.severity
        || manifest.trigger_code != metadata.trigger_code
    {
        return Err(validation(
            "diagnostic manifest does not match request metadata",
        ));
    }
    Ok(())
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
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write;

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

    #[test]
    fn accepts_the_versioned_diagnostic_envelope() {
        let metadata = upload();
        let manifest = serde_json::json!({
            "schema": DIAGNOSTIC_SCHEMA,
            "version": 1,
            "record_type": "manifest",
            "timestamp_ms": 1,
            "source": "renderer",
            "event": "report_manifest",
            "data": {
                "source": metadata.source,
                "release_channel": metadata.release_channel,
                "app_version": metadata.app_version,
                "platform": metadata.platform,
                "area": metadata.area,
                "severity": metadata.severity,
                "trigger_code": metadata.trigger_code,
            }
        });
        let event = serde_json::json!({
            "schema": DIAGNOSTIC_SCHEMA,
            "version": 1,
            "record_type": "event",
            "timestamp_ms": 2,
            "source": "native",
            "event": "screen_started",
            "data": { "duration_ms": 12 }
        });
        let payload = gzip(format!("{manifest}\n{event}").as_bytes());

        assert!(validate_bundle(&payload, &metadata).is_ok());
    }

    #[test]
    fn rejects_manifest_metadata_mismatch_and_gzip_bombs() {
        let metadata = upload();
        let manifest = serde_json::json!({
            "schema": DIAGNOSTIC_SCHEMA,
            "version": 1,
            "record_type": "manifest",
            "timestamp_ms": 1,
            "source": "renderer",
            "event": "report_manifest",
            "data": {
                "source": "web",
                "release_channel": metadata.release_channel,
                "app_version": metadata.app_version,
                "platform": metadata.platform,
                "area": metadata.area,
                "severity": metadata.severity,
                "trigger_code": metadata.trigger_code,
            }
        });
        assert!(validate_bundle(&gzip(manifest.to_string().as_bytes()), &metadata).is_err());

        let oversized = vec![b'x'; MAX_DECOMPRESSED_BYTES + 1];
        assert!(validate_bundle(&gzip(&oversized), &metadata).is_err());
    }

    fn gzip(value: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(value).unwrap();
        encoder.finish().unwrap()
    }
}
