use std::{
    io::{Cursor, Read, Write},
    time::{Duration, SystemTime},
};

use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
    Json, Router,
};
use axum_typed_multipart::{FieldData, TryFromMultipart, TypedMultipart};
use lazy_static::lazy_static;
use serde::{Deserialize, Serialize};
use sha2::Digest;
use syrnike_config::Files;
use syrnike_config::{config, report_internal_error};
use syrnike_database::{iso8601_timestamp::Timestamp, FileHash, Metadata, User};
use syrnike_files::FileStorageRepository;
use syrnike_files::{create_thumbnail, decode_image, is_animated, AUTHENTICATION_TAG_SIZE_BYTES};
use syrnike_result::{create_error, Error, Result, ToSyrnikeError};
use tempfile::NamedTempFile;
use tokio::time::Instant;
use tower_http::cors::{AllowHeaders, Any, CorsLayer};
use url_escape::encode_component;
use utoipa::ToSchema;

use crate::{
    exif::strip_metadata, metadata::generate_metadata, mime_type::determine_mime_type, AppState,
};

/// Build the API router
pub async fn router() -> Router<AppState> {
    let config = config().await;

    let cors = CorsLayer::new()
        .allow_methods([Method::POST])
        .allow_headers(AllowHeaders::mirror_request())
        .expose_headers(vec![
            "X-RateLimit-Limit".try_into().unwrap(),
            "X-RateLimit-Bucket".try_into().unwrap(),
            "X-RateLimit-Remaining".try_into().unwrap(),
            "X-RateLimit-Reset-After".try_into().unwrap(),
        ])
        .allow_origin(Any);

    Router::new()
        .route("/", get(root))
        .route(
            "/:tag",
            post(upload_file)
                .options(options)
                .layer(DefaultBodyLimit::max(
                    config.features.limits.global.body_limit_size,
                )),
        )
        .route("/:tag/:file_id", get(fetch_preview))
        .route("/:tag/:file_id/:file_name", get(fetch_file))
        .layer(cors)
}

lazy_static! {
    /// Short-lived file cache to allow us to populate different CDN regions without increasing bandwidth to S3 provider
    /// Uploads will also be stored here to prevent immediately queued downloads from doing the entire round-trip
    static ref S3_CACHE: moka::future::Cache<String, Result<Vec<u8>>> = moka::future::Cache::builder()
        .weigher(|_key, value: &Result<Vec<u8>>| -> u32 {
            std::mem::size_of::<Result<Vec<u8>>>() as u32 + if let Ok(vec) = value {
                vec.len().try_into().unwrap_or(u32::MAX)
            } else {
                std::mem::size_of::<Error>() as u32
            }
        })
        // TODO config
        // .max_capacity(1024 * 1024 * 1024) // Cache up to 1GiB in memory
        // .max_capacity(512 * 1024 * 1024) // Cache up to 512MiB in memory
        .max_capacity(2 * 1024 * 1024 * 1024) // Cache up to 2GiB in memory
        .time_to_live(Duration::from_secs(5 * 60)) // For up to 5 minutes
        .build();
    /// Temporary cache for generated previews. This avoids re-decoding and re-encoding the same
    /// immutable media on repeated backend hits without storing derived files permanently in S3.
    static ref PREVIEW_CACHE: moka::future::Cache<String, Vec<u8>> = moka::future::Cache::builder()
        .weigher(|_key, value: &Vec<u8>| -> u32 {
            std::mem::size_of::<Vec<u8>>() as u32 + value.len().try_into().unwrap_or(u32::MAX)
        })
        .max_capacity(512 * 1024 * 1024)
        .time_to_live(Duration::from_secs(60 * 60))
        .build();
}

/// Retrieve hash information and file data by given hash
async fn retrieve_file_by_hash(state: &AppState, hash: &FileHash) -> Result<Vec<u8>> {
    if let Some(data) = S3_CACHE.get(&hash.id).await {
        data
    } else {
        let data = report_internal_error!(
            state
                .storage
                .fetch_and_decrypt_file(&hash.bucket_id, &hash.path, &hash.iv)
                .await
        );
        if should_cache_s3_result(&data) {
            S3_CACHE.insert(hash.id.to_owned(), data.clone()).await;
        }
        data
    }
}

fn should_cache_s3_result(data: &Result<Vec<u8>>) -> bool {
    data.is_ok()
}

#[derive(Clone, Copy)]
struct PreviewVariant {
    max_size: [usize; 2],
    webp_quality_bits: u32,
}

fn preview_variant(files: &Files, tag: &str) -> PreviewVariant {
    PreviewVariant {
        max_size: *files.preview.get(tag).expect("preview size"),
        webp_quality_bits: files.webp_quality.to_bits(),
    }
}

fn preview_cache_key(hash: &FileHash, tag: &str, variant: PreviewVariant) -> String {
    let [width, height] = variant.max_size;

    format!(
        "preview:{tag}:{width}x{height}:{:08x}:{}",
        variant.webp_quality_bits, hash.processed_hash
    )
}

fn preview_etag(hash: &FileHash, tag: &str, variant: PreviewVariant) -> String {
    let [width, height] = variant.max_size;

    format!(
        "\"syrnike-preview-{tag}-{width}x{height}-{:08x}-{}\"",
        variant.webp_quality_bits, hash.processed_hash
    )
}

fn original_etag(hash: &FileHash) -> String {
    format!("\"syrnike-original-{}\"", hash.processed_hash)
}

fn last_modified(hash: &FileHash) -> String {
    httpdate::fmt_http_date(SystemTime::from(hash.created_at))
}

fn if_none_match_matches(value: &str, etag: &str) -> bool {
    value.split(',').any(|candidate| {
        let candidate = candidate.trim();
        candidate == "*" || candidate.trim_start_matches("W/") == etag.trim_start_matches("W/")
    })
}

fn if_modified_since_matches(value: &str, last_modified: &str) -> bool {
    let Ok(requested) = httpdate::parse_http_date(value) else {
        return false;
    };
    let Ok(current) = httpdate::parse_http_date(last_modified) else {
        return false;
    };

    requested >= current
}

fn cache_validator_matches(headers: &HeaderMap, etag: &str, last_modified: &str) -> bool {
    if let Some(value) = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
    {
        return if_none_match_matches(value, etag);
    }

    headers
        .get(header::IF_MODIFIED_SINCE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| if_modified_since_matches(value, last_modified))
}

fn insert_cache_headers(headers: &mut HeaderMap, etag: &str, last_modified: &str) {
    headers.insert(
        header::ETAG,
        HeaderValue::from_str(etag).expect("generated etag is a valid header"),
    );
    headers.insert(
        header::LAST_MODIFIED,
        HeaderValue::from_str(last_modified).expect("generated date is a valid header"),
    );
}

fn not_modified_response(etag: &str, last_modified: &str) -> Response {
    let mut response = (
        StatusCode::NOT_MODIFIED,
        [(header::CACHE_CONTROL, CACHE_CONTROL)],
    )
        .into_response();
    insert_cache_headers(response.headers_mut(), etag, last_modified);
    response
}

fn with_cache_validators(mut response: Response, etag: &str, last_modified: &str) -> Response {
    insert_cache_headers(response.headers_mut(), etag, last_modified);
    response
}

/// Successful root response
#[derive(Serialize, Debug, ToSchema)]
pub struct RootResponse {
    autumn: &'static str,
    version: &'static str,
}

/// Capture crate version from Cargo
static CRATE_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Root response from service
#[utoipa::path(
    get,
    path = "/",
    responses(
        (status = 200, description = "Echo response", body = RootResponse)
    )
)]
async fn root() -> Json<RootResponse> {
    Json(RootResponse {
        autumn: "Hello, I am a file server!",
        version: CRATE_VERSION,
    })
}

/// Empty handler for OPTIONS routes
async fn options() {}

/// Available tags to upload to
#[derive(Clone, Deserialize, Debug, ToSchema, strum_macros::IntoStaticStr)]
#[allow(non_camel_case_types)]
pub enum Tag {
    attachments,
    avatars,
    backgrounds,
    icons,
    banners,
    emojis,
    badges,
}

const PROFILE_GIF_UPLOAD_SIZE_LIMIT: usize = 10_000_000;
const BADGE_UPLOAD_SIZE_LIMIT: usize = 10_000_000;
const BADGE_MIN_SIZE: isize = 64;
const BADGE_MAX_SIZE: isize = 1024;

fn effective_upload_size_limit(tag: &Tag, mime_type: &str, configured_limit: usize) -> usize {
    if matches!(tag, Tag::badges) {
        BADGE_UPLOAD_SIZE_LIMIT
    } else if mime_type == "image/gif" && matches!(tag, Tag::avatars | Tag::backgrounds) {
        PROFILE_GIF_UPLOAD_SIZE_LIMIT
    } else {
        configured_limit
    }
}

fn original_content_disposition(tag: &Tag, content_type: &str) -> &'static str {
    if content_type == "image/gif" && matches!(tag, Tag::avatars | Tag::backgrounds) {
        "inline"
    } else {
        "attachment"
    }
}

fn validate_badge_upload(mime_type: &str, metadata: &Metadata) -> Result<()> {
    if !matches!(mime_type, "image/png" | "image/webp") {
        return Err(create_error!(FileTypeNotAllowed));
    }

    let Metadata::Image { width, height, .. } = metadata else {
        return Err(create_error!(FileTypeNotAllowed));
    };

    if width != height {
        return Err(create_error!(FileTypeNotAllowed));
    }

    if *width < BADGE_MIN_SIZE || *width > BADGE_MAX_SIZE {
        return Err(create_error!(FileTypeNotAllowed));
    }

    Ok(())
}

/// Request body for upload
#[derive(ToSchema, TryFromMultipart)]
pub struct UploadPayload {
    #[schema(format = Binary)]
    #[allow(dead_code)]
    #[form_data(limit = "unlimited")] // handled by axum
    file: FieldData<NamedTempFile>,
}

/// Successful upload response
#[derive(Serialize, Debug, ToSchema)]
pub struct UploadResponse {
    /// ID to attach uploaded file to object
    id: String,
}

/// Upload a file
///
/// Available tags and restrictions:
///
/// | Tag | Size | Resolution | Type |
/// | :-: | --: | :-- | :-: |
/// | attachments | 20 MB | - | Any |
/// | avatars | 4 MB, GIF up to 10 MB | 40 MP or 10,000px | Image |
/// | backgrounds | 6 MB, GIF up to 10 MB | 40 MP or 10,000px | Image |
/// | icons | 2.5 MB | 40 MP or 10,000px | Image |
/// | banners | 6 MB | 40 MP or 10,000px | Image |
/// | emojis | 500 KB | 40 MP or 10,000px | Image |
/// | badges | 10 MB | 64-1024px square | PNG/WebP |
#[utoipa::path(
    post,
    path = "/{tag}",
    responses(
        (status = 200, description = "Upload was successful", body = UploadResponse)
    ),
    params(
        ("tag" = Tag, Path, description = "Tag to upload to (e.g. attachments, icons, ...)")
    ),
    request_body(content_type = "multipart/form-data", content = UploadPayload),
    security(
        ("session_token" = []),
        ("bot_token" = [])
    )
)]
async fn upload_file(
    State(state): State<AppState>,
    user: User,
    Path(tag): Path<Tag>,
    TypedMultipart(UploadPayload { mut file }): TypedMultipart<UploadPayload>,
) -> Result<Json<UploadResponse>> {
    let db = &state.database;
    // Fetch configuration
    let config = config().await;

    // Keep track of processing time
    let now = Instant::now();

    // Extract the filename, or give it a generic name
    let filename = file.metadata.file_name.unwrap_or("unnamed-file".to_owned());

    // Load file to memory
    let mut buf = Vec::<u8>::new();
    report_internal_error!(file.contents.read_to_end(&mut buf))?;

    // Take note of original file size
    let original_file_size = buf.len();

    // Ensure the file is not empty
    if original_file_size < config.files.limit.min_file_size {
        return Err(create_error!(FileTooSmall));
    }

    // Determine the mime type for the file before choosing tag-specific limits.
    let mime_type = determine_mime_type(&mut file.contents, &buf, &filename);

    // Get user's file upload limits
    let limits = user.limits().await;
    let tag_name: &'static str = tag.clone().into();
    let configured_size_limit = *limits
        .file_upload_size_limit
        .get(tag_name)
        .expect("size limit");
    let size_limit = effective_upload_size_limit(&tag, mime_type, configured_size_limit);

    if original_file_size > size_limit {
        return Err(create_error!(FileTooLarge { max: size_limit }));
    }

    // Generate sha256 hash
    let original_hash = {
        let mut hasher = sha2::Sha256::new();
        hasher.update(&buf);
        hasher.finalize()
    };

    // Generate an ID for this file
    let id = if matches!(tag, Tag::emojis) {
        ulid::Ulid::new().to_string()
    } else {
        nanoid::nanoid!(42)
    };

    // Check blocklist for mime type
    if config
        .files
        .blocked_mime_types
        .iter()
        .any(|m| m == mime_type)
    {
        return Err(create_error!(FileTypeNotAllowed));
    }

    // Determine metadata for the file
    let metadata = generate_metadata(&file.contents, mime_type);

    // Block non-images for non-attachment uploads
    if !matches!(tag, Tag::attachments) && !matches!(metadata, Metadata::Image { .. }) {
        return Err(create_error!(FileTypeNotAllowed));
    }

    if matches!(tag, Tag::badges) {
        validate_badge_upload(mime_type, &metadata)?;
    }

    // Find an existing hash and use that if possible
    let file_hash_exists = if let Ok(file_hash) = db
        .fetch_attachment_hash(&format!("{original_hash:02x}"))
        .await
    {
        if !file_hash.iv.is_empty() {
            if retrieve_file_by_hash(&state, &file_hash).await.is_ok() {
                let tag: &'static str = tag.into();
                db.insert_attachment(&file_hash.into_file(
                    id.clone(),
                    tag.to_owned(),
                    filename,
                    user.id,
                ))
                .await?;

                return Ok(Json(UploadResponse { id }));
            }

            tracing::warn!(
                "Existing file hash {original_hash:02x} could not be read; overwriting S3 object with a fresh encrypted upload."
            );
        }

        true
    } else {
        false
    };

    // Strip metadata
    let (buf, metadata) = strip_metadata(file.contents, buf, metadata, mime_type).await?;

    // Virus scan files if ClamAV is configured
    if matches!(metadata, Metadata::File)
        && (config.files.scan_mime_types.is_empty()
            || config.files.scan_mime_types.iter().any(|v| v == mime_type))
        && crate::clamav::is_malware(&buf).await?
    {
        return Err(create_error!(InternalError));
    }

    // Print file information for debug purposes
    let new_file_size = buf.len() + AUTHENTICATION_TAG_SIZE_BYTES;
    let processed_hash = {
        let mut hasher = sha2::Sha256::new();
        hasher.update(&buf);
        hasher.finalize()
    };
    let process_ratio = new_file_size as f32 / original_file_size as f32;
    let time_to_process = Instant::now() - now;

    tracing::info!("Received file {filename}\nOriginal hash: {original_hash:02x}\nOriginal size: {original_file_size} bytes\nMime type: {mime_type}\nMetadata: {metadata:?}\nProcessed file size: {new_file_size} bytes ({:.2}%).\nProcessed hash: {processed_hash:02x}\nProcessing took {time_to_process:?}", process_ratio * 100.0);

    // Create hash entry in database
    let file_hash = FileHash {
        id: format!("{original_hash:02x}"),
        processed_hash: format!("{processed_hash:02x}"),

        created_at: Timestamp::now_utc(),

        bucket_id: config.files.s3.default_bucket,
        path: format!("{original_hash:02x}"),
        iv: String::new(), // indicates file is not uploaded yet

        metadata,
        content_type: mime_type.to_owned(),
        size: new_file_size as isize,
    };

    // Add attachment hash if it doesn't exist
    if !file_hash_exists {
        db.insert_attachment_hash(&file_hash).await?;
    }

    // Upload the file to S3 and commit nonce to database
    let upload_start = Instant::now();
    let nonce = report_internal_error!(
        state
            .storage
            .encrypt_and_upload_file(&file_hash.bucket_id, &file_hash.id, &buf)
            .await
    )?;
    db.set_attachment_hash_nonce(&file_hash.id, &nonce).await?;
    S3_CACHE
        .insert(file_hash.id.to_owned(), Ok(buf.clone()))
        .await;

    // Debug information
    let time_to_upload = Instant::now() - upload_start;
    tracing::info!("Took {time_to_upload:?} to upload {new_file_size} bytes to S3.");

    // Finally, create the file and return its ID
    let tag: &'static str = tag.into();
    db.insert_attachment(&file_hash.into_file(id.clone(), tag.to_owned(), filename, user.id))
        .await?;

    Ok(Json(UploadResponse { id }))
}

/// Header value used for cache control
pub static CACHE_CONTROL: &str = "public, max-age=604800, immutable";

/// Fetch preview of file
///
/// This route will only return image content. <br>
/// For all other file types, please use the fetch route (you will receive a redirect if you try to use this route anyways!).
///
/// Depending on the given tag, the file will be re-processed to fit the criteria:
///
/// | Tag | Image Resolution <sup>†</sup> | Animations stripped by preview <sup>‡</sup> |
/// | :-: | --- | :-: |
/// | attachments | Up to 1280px on any axis | ❌ |
/// | avatars | Up to 256px on any axis | ✅ |
/// | backgrounds | Up to 1280x720px | ❌ |
/// | icons | Up to 128px on any axis | ✅ |
/// | banners | Up to 480px on any axis | ❌ |
/// | emojis | Up to 128px on any axis | ❌ |
/// | badges | Up to 128px on any axis | ✅ |
///
/// <sup>†</sup> aspect ratio will always be preserved
///
/// <sup>‡</sup> to fetch animated variant, suffix `/{file_name}` or `/original` to the path
#[utoipa::path(
    get,
    path = "/{tag}/{file_id}",
    responses(
        (status = 200, description = "Generated preview", body = Vec<u8>)
    ),
    params(
        ("tag" = Tag, Path, description = "Tag to fetch from (e.g. attachments, icons, ...)"),
        ("file_id" = String, Path, description = "File identifier")
    ),
)]
async fn fetch_preview(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((tag, file_id)): Path<(Tag, String)>,
) -> Result<Response> {
    let db = &state.database;
    let files_config = config().await.files;
    let tag_str: &'static str = tag.clone().into();
    let file = db.fetch_attachment(tag_str, &file_id).await?;

    // Ignore deleted files
    if file.deleted.is_some_and(|v| v) {
        return Err(create_error!(NotFound));
    }

    // Ignore files that haven't been attached
    if file.used_for.is_none() {
        return Err(create_error!(NotFound));
    }

    let hash = file.as_hash(&db).await?;
    let variant = preview_variant(&files_config, tag_str);
    let etag = preview_etag(&hash, tag_str, variant);
    let last_modified = last_modified(&hash);

    if cache_validator_matches(&headers, &etag, &last_modified) {
        return Ok(not_modified_response(&etag, &last_modified));
    }

    let mut data = None;

    // If animated is unset, check the file contents to see if it is animated and update the filehash
    let is_animated = match &hash.metadata {
        Metadata::Image {
            animated: Some(value),
            ..
        } => *value,
        Metadata::Image { animated: None, .. } => {
            let file_data = retrieve_file_by_hash(&state, &hash).await?;

            let mut named_file = NamedTempFile::new().to_internal_error()?;
            named_file.write(&file_data).to_internal_error()?;

            data = Some(file_data);

            // If it fails for some reason, set it to not be animated
            let animated = is_animated(&named_file, &hash.content_type).unwrap_or(false);
            db.set_attachment_hash_animated(&hash.id, animated).await?;

            animated
        }
        _ => false,
    };

    // Only process image files and don't process GIFs if not avatar or icon
    if !matches!(hash.metadata, Metadata::Image { .. })
        || (is_animated && !matches!(tag, Tag::avatars | Tag::icons | Tag::badges))
    {
        let safe_filename = encode_component(&file.filename);

        return Ok(with_cache_validators(
            (
                [(header::CACHE_CONTROL, CACHE_CONTROL)],
                Redirect::permanent(&format!("/{tag_str}/{file_id}/{safe_filename}")),
            )
                .into_response(),
            &etag,
            &last_modified,
        ));
    }

    let cache_key = preview_cache_key(&hash, tag_str, variant);
    if let Some(data) = PREVIEW_CACHE.get(&cache_key).await {
        return Ok(with_cache_validators(
            (
                [
                    (header::CONTENT_TYPE, "image/webp"),
                    (header::CONTENT_DISPOSITION, "inline"),
                    (header::CACHE_CONTROL, CACHE_CONTROL),
                ],
                data,
            )
                .into_response(),
            &etag,
            &last_modified,
        ));
    }

    // Original image data
    let data = if let Some(data) = data {
        data
    } else {
        retrieve_file_by_hash(&state, &hash).await?
    };

    // Read image and create thumbnail
    let data = create_thumbnail(
        decode_image(&mut Cursor::new(data), &file.content_type)?,
        tag_str,
    )
    .await;
    PREVIEW_CACHE.insert(cache_key, data.clone()).await;

    Ok(with_cache_validators(
        (
            [
                (header::CONTENT_TYPE, "image/webp"),
                (header::CONTENT_DISPOSITION, "inline"),
                (header::CACHE_CONTROL, CACHE_CONTROL),
            ],
            data,
        )
            .into_response(),
        &etag,
        &last_modified,
    ))
}

/// Fetch original file
///
/// Content disposition is usually set to 'attachment' to prevent browser rendering.
/// Profile GIF originals in `avatars` and `backgrounds` are served as `inline`.
///
/// Using `original` as the file name parameter redirects to the original filename.
/// For profile GIF originals, that redirected response can be delivered inline.
#[utoipa::path(
    get,
    path = "/{tag}/{file_id}/{file_name}",
    responses(
        (status = 200, description = "Original file", body = Vec<u8>)
    ),
    params(
        ("tag" = Tag, Path, description = "Tag to fetch from (e.g. attachments, icons, ...)"),
        ("file_id" = String, Path, description = "File identifier"),
        ("file_name" = String, Path, description = "File name")
    ),
)]
async fn fetch_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((tag, file_id, file_name)): Path<(Tag, String, String)>,
) -> Result<Response> {
    let db = &state.database;
    let tag_str: &'static str = tag.clone().into();
    let file = db.fetch_attachment(tag_str, &file_id).await?;

    // Ignore deleted files
    if file.deleted.is_some_and(|v| v) {
        return Err(create_error!(NotFound));
    }

    // Ignore files that haven't been attached
    if file.used_for.is_none() {
        return Err(create_error!(NotFound));
    }

    // Ensure filename is correct
    if file_name != file.filename {
        if file_name == "original" {
            let safe_filename = encode_component(&file.filename);

            return Ok((
                [(header::CACHE_CONTROL, CACHE_CONTROL)],
                Redirect::permanent(&format!("/{tag_str}/{file_id}/{}", safe_filename)),
            )
                .into_response());
        }

        return Err(create_error!(NotFound));
    }

    let hash = file.as_hash(&db).await?;
    let etag = original_etag(&hash);
    let last_modified = last_modified(&hash);

    if cache_validator_matches(&headers, &etag, &last_modified) {
        return Ok(not_modified_response(&etag, &last_modified));
    }

    let content_disposition = original_content_disposition(&tag, &hash.content_type);
    retrieve_file_by_hash(&state, &hash).await.map(|data| {
        with_cache_validators(
            (
                [
                    (header::CONTENT_TYPE, hash.content_type),
                    (header::CONTENT_DISPOSITION, content_disposition.to_owned()),
                    (header::CACHE_CONTROL, CACHE_CONTROL.to_owned()),
                ],
                data,
            )
                .into_response(),
            &etag,
            &last_modified,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::{
        cache_validator_matches, effective_upload_size_limit, original_content_disposition,
        original_etag, preview_cache_key, preview_etag, should_cache_s3_result,
        validate_badge_upload, PreviewVariant, Tag, BADGE_UPLOAD_SIZE_LIMIT, CACHE_CONTROL,
        PROFILE_GIF_UPLOAD_SIZE_LIMIT,
    };
    use axum::http::{header, HeaderMap, HeaderValue};
    use syrnike_database::Metadata;
    use syrnike_database::{iso8601_timestamp::Timestamp, FileHash};

    #[test]
    fn gif_avatars_and_backgrounds_use_profile_gif_upload_limit() {
        assert_eq!(
            effective_upload_size_limit(&Tag::avatars, "image/gif", 4_000_000),
            PROFILE_GIF_UPLOAD_SIZE_LIMIT,
        );
        assert_eq!(
            effective_upload_size_limit(&Tag::backgrounds, "image/gif", 6_000_000),
            PROFILE_GIF_UPLOAD_SIZE_LIMIT,
        );
    }

    #[test]
    fn badge_uploads_use_hard_size_limit() {
        assert_eq!(
            effective_upload_size_limit(&Tag::badges, "image/png", 1),
            BADGE_UPLOAD_SIZE_LIMIT,
        );
    }

    #[test]
    fn badge_uploads_accept_square_png_and_webp() {
        let metadata = Metadata::Image {
            width: 128,
            height: 128,
            thumbhash: None,
            animated: None,
        };

        assert!(validate_badge_upload("image/png", &metadata).is_ok());
        assert!(validate_badge_upload("image/webp", &metadata).is_ok());
    }

    #[test]
    fn badge_uploads_reject_wrong_type_shape_and_size() {
        let valid_size = Metadata::Image {
            width: 128,
            height: 128,
            thumbhash: None,
            animated: None,
        };
        let non_square = Metadata::Image {
            width: 128,
            height: 64,
            thumbhash: None,
            animated: None,
        };
        let too_small = Metadata::Image {
            width: 63,
            height: 63,
            thumbhash: None,
            animated: None,
        };
        let too_large = Metadata::Image {
            width: 1025,
            height: 1025,
            thumbhash: None,
            animated: None,
        };

        assert!(validate_badge_upload("image/jpeg", &valid_size).is_err());
        assert!(validate_badge_upload("image/png", &non_square).is_err());
        assert!(validate_badge_upload("image/png", &too_small).is_err());
        assert!(validate_badge_upload("image/png", &too_large).is_err());
    }

    #[test]
    fn non_profile_gif_and_non_gif_uploads_keep_configured_limit() {
        assert_eq!(
            effective_upload_size_limit(&Tag::attachments, "image/gif", 20_000_000),
            20_000_000,
        );
        assert_eq!(
            effective_upload_size_limit(&Tag::avatars, "image/png", 4_000_000),
            4_000_000,
        );
    }

    #[test]
    fn only_profile_gif_originals_are_inline() {
        assert_eq!(
            original_content_disposition(&Tag::avatars, "image/gif"),
            "inline"
        );
        assert_eq!(
            original_content_disposition(&Tag::backgrounds, "image/gif"),
            "inline",
        );
        assert_eq!(
            original_content_disposition(&Tag::attachments, "image/gif"),
            "attachment",
        );
        assert_eq!(
            original_content_disposition(&Tag::avatars, "image/png"),
            "attachment",
        );
    }

    #[test]
    fn media_cache_control_keeps_immutable_files_fresh() {
        assert_eq!(CACHE_CONTROL, "public, max-age=604800, immutable");
    }

    #[test]
    fn s3_cache_keeps_successful_reads_only() {
        let ok: syrnike_result::Result<Vec<u8>> = Ok(vec![1, 2, 3]);
        let err: syrnike_result::Result<Vec<u8>> =
            Err(syrnike_result::create_error!(InternalError));

        assert!(should_cache_s3_result(&ok));
        assert!(!should_cache_s3_result(&err));
    }

    fn image_hash() -> FileHash {
        FileHash {
            id: "original-sha".to_owned(),
            processed_hash: "processed-sha".to_owned(),
            created_at: Timestamp::UNIX_EPOCH,
            bucket_id: "bucket".to_owned(),
            path: "path".to_owned(),
            iv: "iv".to_owned(),
            metadata: Metadata::Image {
                width: 128,
                height: 128,
                thumbhash: None,
                animated: Some(false),
            },
            content_type: "image/png".to_owned(),
            size: 123,
        }
    }

    #[test]
    fn preview_cache_key_is_temporary_cache_only_and_tag_specific() {
        let hash = image_hash();

        assert_eq!(
            preview_cache_key(
                &hash,
                "avatars",
                PreviewVariant {
                    max_size: [256, 256],
                    webp_quality_bits: 80.0_f32.to_bits(),
                },
            ),
            "preview:avatars:256x256:42a00000:processed-sha"
        );
        assert_ne!(
            preview_cache_key(
                &hash,
                "avatars",
                PreviewVariant {
                    max_size: [256, 256],
                    webp_quality_bits: 80.0_f32.to_bits(),
                },
            ),
            preview_cache_key(
                &hash,
                "backgrounds",
                PreviewVariant {
                    max_size: [1280, 720],
                    webp_quality_bits: 80.0_f32.to_bits(),
                },
            )
        );
    }

    #[test]
    fn media_etags_are_stable_and_distinguish_preview_from_original() {
        let hash = image_hash();

        assert_eq!(
            preview_etag(
                &hash,
                "avatars",
                PreviewVariant {
                    max_size: [256, 256],
                    webp_quality_bits: 80.0_f32.to_bits(),
                },
            ),
            "\"syrnike-preview-avatars-256x256-42a00000-processed-sha\""
        );
        assert_eq!(original_etag(&hash), "\"syrnike-original-processed-sha\"");
        assert_ne!(
            preview_etag(
                &hash,
                "avatars",
                PreviewVariant {
                    max_size: [256, 256],
                    webp_quality_bits: 80.0_f32.to_bits(),
                },
            ),
            original_etag(&hash)
        );
    }

    #[test]
    fn preview_validators_change_when_preview_settings_change() {
        let hash = image_hash();
        let default_variant = PreviewVariant {
            max_size: [256, 256],
            webp_quality_bits: 80.0_f32.to_bits(),
        };
        let resized_variant = PreviewVariant {
            max_size: [512, 512],
            webp_quality_bits: 80.0_f32.to_bits(),
        };
        let quality_variant = PreviewVariant {
            max_size: [256, 256],
            webp_quality_bits: 90.0_f32.to_bits(),
        };

        assert_ne!(
            preview_cache_key(&hash, "avatars", default_variant),
            preview_cache_key(&hash, "avatars", resized_variant),
        );
        assert_ne!(
            preview_cache_key(&hash, "avatars", default_variant),
            preview_cache_key(&hash, "avatars", quality_variant),
        );
        assert_ne!(
            preview_etag(&hash, "avatars", default_variant),
            preview_etag(&hash, "avatars", resized_variant),
        );
    }

    #[test]
    fn cache_validator_matches_current_etag() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::IF_NONE_MATCH,
            HeaderValue::from_static("\"syrnike-preview-avatars-processed-sha\""),
        );

        assert!(cache_validator_matches(
            &headers,
            "\"syrnike-preview-avatars-processed-sha\"",
            "Thu, 01 Jan 1970 00:00:00 GMT",
        ));
    }

    #[test]
    fn cache_validator_ignores_last_modified_when_etag_misses() {
        let mut headers = HeaderMap::new();
        headers.insert(header::IF_NONE_MATCH, HeaderValue::from_static("\"old\""));
        headers.insert(
            header::IF_MODIFIED_SINCE,
            HeaderValue::from_static("Thu, 01 Jan 1970 00:00:00 GMT"),
        );

        assert!(!cache_validator_matches(
            &headers,
            "\"syrnike-preview-avatars-processed-sha\"",
            "Thu, 01 Jan 1970 00:00:00 GMT",
        ));
    }

    #[test]
    fn cache_validator_matches_last_modified_when_etag_is_absent() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::IF_MODIFIED_SINCE,
            HeaderValue::from_static("Thu, 01 Jan 1970 00:00:00 GMT"),
        );

        assert!(cache_validator_matches(
            &headers,
            "\"syrnike-preview-avatars-processed-sha\"",
            "Thu, 01 Jan 1970 00:00:00 GMT",
        ));
    }
}
