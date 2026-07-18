use revolt_okapi::openapi3::{self, MediaType, RefOr};
use rocket::http::ContentType;
use rocket::response::{self, Responder};
use rocket::serde::json::Json;
use rocket::{Request, Response, State};
use schemars::schema::{InstanceType, SchemaObject, SingleOrVec};
use serde::{Deserialize, Serialize};
use syrnike_database::{
    Database, DiagnosticReport, DiagnosticReportQuery, DiagnosticReportStatus, User,
};
use syrnike_files::fetch_from_s3;
use syrnike_result::Result;

use super::require_privileged;

#[derive(Debug, Serialize, JsonSchema)]
pub struct DiagnosticReportResponse {
    pub id: String,
    pub user_id: String,
    pub created_at: u64,
    pub expires_at: u64,
    pub source: String,
    pub release_channel: String,
    pub app_version: String,
    pub platform: String,
    pub area: String,
    pub severity: String,
    pub trigger_code: String,
    pub description: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub status: String,
    pub notes: String,
}

impl From<DiagnosticReport> for DiagnosticReportResponse {
    fn from(value: DiagnosticReport) -> Self {
        Self {
            id: value.id,
            user_id: value.user_id,
            created_at: value.created_at,
            expires_at: value.expires_at,
            source: value.source,
            release_channel: value.release_channel,
            app_version: value.app_version,
            platform: value.platform,
            area: value.area,
            severity: value.severity,
            trigger_code: value.trigger_code,
            description: value.description,
            size_bytes: value.size_bytes,
            sha256: value.sha256,
            status: status_label(value.status).to_owned(),
            notes: value.notes,
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct UpdateDiagnosticReport {
    pub status: String,
    #[serde(default)]
    pub notes: String,
}

#[openapi(tag = "Admin")]
#[get("/diagnostics?<before>&<user_id>&<source>&<release_channel>&<area>&<trigger_code>&<status>&<limit>")]
pub async fn list(
    db: &State<Database>,
    user: User,
    before: Option<String>,
    user_id: Option<String>,
    source: Option<String>,
    release_channel: Option<String>,
    area: Option<String>,
    trigger_code: Option<String>,
    status: Option<String>,
    limit: Option<usize>,
) -> Result<Json<Vec<DiagnosticReportResponse>>> {
    require_privileged(&user)?;
    let status = status.as_deref().map(parse_status).transpose()?;
    let reports = db
        .fetch_diagnostic_reports(DiagnosticReportQuery {
            before,
            user_id,
            source,
            release_channel,
            area,
            trigger_code,
            status,
            limit: limit.unwrap_or(50),
        })
        .await?;
    Ok(Json(reports.into_iter().map(Into::into).collect()))
}

#[openapi(tag = "Admin")]
#[get("/diagnostics/<id>", rank = 2)]
pub async fn fetch(
    db: &State<Database>,
    user: User,
    id: String,
) -> Result<Json<DiagnosticReportResponse>> {
    require_privileged(&user)?;
    Ok(Json(db.fetch_diagnostic_report(&id).await?.into()))
}

#[openapi(tag = "Admin")]
#[patch("/diagnostics/<id>", data = "<data>")]
pub async fn update(
    db: &State<Database>,
    user: User,
    id: String,
    data: Json<UpdateDiagnosticReport>,
) -> Result<Json<DiagnosticReportResponse>> {
    require_privileged(&user)?;
    let data = data.into_inner();
    let notes = data.notes.chars().take(4_000).collect();
    db.update_diagnostic_report(&id, parse_status(&data.status)?, notes)
        .await?;
    Ok(Json(db.fetch_diagnostic_report(&id).await?.into()))
}

pub struct DiagnosticDownload {
    body: Vec<u8>,
    filename: String,
}

impl<'r> Responder<'r, 'static> for DiagnosticDownload {
    fn respond_to(self, req: &'r Request<'_>) -> response::Result<'static> {
        Response::build_from((ContentType::new("application", "gzip"), self.body).respond_to(req)?)
            .raw_header(
                "Content-Disposition",
                format!("attachment; filename=\"{}\"", self.filename),
            )
            .raw_header("Cache-Control", "private, no-store")
            .ok()
    }
}

impl revolt_rocket_okapi::response::OpenApiResponderInner for DiagnosticDownload {
    fn responses(
        _gen: &mut revolt_rocket_okapi::gen::OpenApiGenerator,
    ) -> std::result::Result<openapi3::Responses, revolt_rocket_okapi::OpenApiError> {
        let mut responses = schemars::Map::new();
        let mut content = schemars::Map::new();
        content.insert(
            "application/gzip".to_owned(),
            MediaType {
                schema: Some(SchemaObject {
                    instance_type: Some(SingleOrVec::Single(Box::new(InstanceType::String))),
                    format: Some("binary".to_owned()),
                    ..Default::default()
                }),
                ..Default::default()
            },
        );
        responses.insert(
            "200".to_owned(),
            RefOr::Object(openapi3::Response {
                description:
                    "Encrypted diagnostic bundle, decrypted for an authorized administrator"
                        .to_owned(),
                content,
                ..Default::default()
            }),
        );
        Ok(openapi3::Responses {
            responses,
            ..Default::default()
        })
    }
}

#[openapi(tag = "Admin")]
#[get("/diagnostics/<id>/download")]
pub async fn download(db: &State<Database>, user: User, id: String) -> Result<DiagnosticDownload> {
    require_privileged(&user)?;
    let report = db.fetch_diagnostic_report(&id).await?;
    let body = fetch_from_s3(&report.bucket_id, &report.object_key, &report.encryption_iv).await?;
    Ok(DiagnosticDownload {
        body,
        filename: format!("syrnike13-diagnostic-{}.jsonl.gz", report.id),
    })
}

fn parse_status(value: &str) -> Result<DiagnosticReportStatus> {
    match value {
        "new" => Ok(DiagnosticReportStatus::New),
        "investigating" => Ok(DiagnosticReportStatus::Investigating),
        "resolved" => Ok(DiagnosticReportStatus::Resolved),
        _ => Err(syrnike_result::create_error!(FailedValidation {
            error: "invalid diagnostic report status".to_owned()
        })),
    }
}

fn status_label(value: DiagnosticReportStatus) -> &'static str {
    match value {
        DiagnosticReportStatus::New => "new",
        DiagnosticReportStatus::Investigating => "investigating",
        DiagnosticReportStatus::Resolved => "resolved",
    }
}
