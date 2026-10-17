use revolt_okapi::openapi3::{self, MediaType, RefOr};
use rocket::{
    data::ToByteUnit,
    http::ContentType,
    response::{self, Responder},
    Data, Request, Response, State,
};
use rocket_empty::EmptyResponse;
use schemars::schema::{InstanceType, SchemaObject};
use syrnike_database::{
    util::{permissions::DatabasePermissionQuery, reference::Reference},
    voice::stream_preview::{self, MAX_STREAM_PREVIEW_BYTES},
    Database, User,
};
use syrnike_permissions::{calculate_channel_permissions, ChannelPermission};
use syrnike_result::{create_error, Result, ToSyrnikeError};

pub struct PreviewImage(stream_preview::StreamPreview);

impl<'r> Responder<'r, 'static> for PreviewImage {
    fn respond_to(self, req: &'r Request<'_>) -> response::Result<'static> {
        let content_type =
            ContentType::parse_flexible(&self.0.content_type).unwrap_or(ContentType::Binary);
        Response::build_from((content_type, self.0.image).respond_to(req)?)
            .raw_header("Cache-Control", "no-store")
            .raw_header("X-Content-Type-Options", "nosniff")
            .raw_header("X-Stream-Preview-Updated-At", self.0.updated_at)
            .ok()
    }
}

impl revolt_rocket_okapi::response::OpenApiResponderInner for PreviewImage {
    fn responses(
        _gen: &mut revolt_rocket_okapi::gen::OpenApiGenerator,
    ) -> std::result::Result<openapi3::Responses, revolt_rocket_okapi::OpenApiError> {
        let mut content = schemars::Map::new();
        for mime in ["image/webp", "image/jpeg"] {
            content.insert(
                mime.to_string(),
                MediaType {
                    schema: Some(SchemaObject {
                        instance_type: Some(InstanceType::String.into()),
                        format: Some("binary".to_string()),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            );
        }
        let mut responses = schemars::Map::new();
        responses.insert(
            "200".to_string(),
            RefOr::Object(openapi3::Response {
                description: "Stream preview image".to_string(),
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

/// Upload the authenticated streamer's current screen preview (WebP or JPEG, at most 256 KiB).
#[openapi(tag = "Voice")]
#[put("/<target>/voice/stream-preview", data = "<data>")]
pub async fn put_preview(
    user: User,
    target: Reference<'_>,
    content_type: &ContentType,
    data: Data<'_>,
) -> Result<EmptyResponse> {
    let content_type = content_type.media_type().to_string();
    let bytes = data
        .open((MAX_STREAM_PREVIEW_BYTES as u64).bytes())
        .into_bytes()
        .await
        .to_internal_error()?;
    if !bytes.is_complete() || !stream_preview::valid_stream_preview(&content_type, &bytes) {
        return Err(create_error!(InvalidOperation));
    }
    stream_preview::put_stream_preview(target.id, &user.id, &content_type, &bytes).await?;
    Ok(EmptyResponse)
}

/// Fetch a stream preview without joining or subscribing to the voice channel.
#[openapi(tag = "Voice")]
#[get("/<target>/voice/stream-preview/<user_id>")]
pub async fn get_preview(
    db: &State<Database>,
    user: User,
    target: Reference<'_>,
    user_id: &str,
) -> Result<PreviewImage> {
    let channel = target.as_channel(db).await?;
    if channel.has_bot_recipient(db).await? {
        return Err(create_error!(NotFound));
    }
    calculate_channel_permissions(&mut DatabasePermissionQuery::new(db, &user).channel(&channel))
        .await
        .throw_if_lacking_channel_permission(ChannelPermission::ViewChannel)?;
    stream_preview::get_stream_preview(channel.id(), user_id)
        .await?
        .map(PreviewImage)
        .ok_or_else(|| create_error!(NotFound))
}
