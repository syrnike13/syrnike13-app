use redis_kiss::redis::cmd;
use syrnike_result::{create_error, Result, ToSyrnikeError};

use super::{get_connection, get_current_voice_session, voice_current_key};

pub const MAX_STREAM_PREVIEW_BYTES: usize = 256 * 1024;
pub const STREAM_PREVIEW_TTL_SECONDS: usize = 10 * 60;

// Used by every preview operation; validate only the fields that authorize sharing.
const VALIDATE_STREAM_SESSION: &str = r#"
local function stream_session_active(operation_id, channel_id)
    if not operation_id then return false end
    local raw = redis.call('GET', 'voice_session:' .. operation_id)
    if not raw then return false end
    local session = cjson.decode(raw)
    return session.state == 'active' and session.channel.id == channel_id
        and session.screensharing == true
end
local operation_id = redis.call('GET', KEYS[1])
"#;

const PRUNE_STREAM_PREVIEW: &str = r#"
if not stream_session_active(operation_id, ARGV[1])
    or redis.call('HGET', KEYS[2], 'operation_id') ~= operation_id then
    redis.call('DEL', KEYS[2])
    return false
end
"#;

fn preview_read_script(fetch_image: bool) -> String {
    format!(
        "{VALIDATE_STREAM_SESSION}{PRUNE_STREAM_PREVIEW}{}",
        if fetch_image {
            "return redis.call('HMGET', KEYS[2], 'content_type', 'image', 'updated_at')"
        } else {
            "return true"
        }
    )
}

pub fn stream_preview_key(channel_id: &str, user_id: &str) -> String {
    format!("voice_stream_preview:{channel_id}:{user_id}")
}

pub fn valid_stream_preview(content_type: &str, image: &[u8]) -> bool {
    if image.is_empty() || image.len() > MAX_STREAM_PREVIEW_BYTES {
        return false;
    }
    match content_type {
        "image/jpeg" => image.starts_with(&[0xff, 0xd8, 0xff]) && image.ends_with(&[0xff, 0xd9]),
        "image/webp" => {
            image.len() >= 20
                && &image[..4] == b"RIFF"
                && &image[8..12] == b"WEBP"
                && matches!(&image[12..16], b"VP8 " | b"VP8L" | b"VP8X")
                && u32::from_le_bytes([image[4], image[5], image[6], image[7]]) as usize
                    == image.len() - 8
        }
        _ => false,
    }
}

pub struct StreamPreview {
    pub content_type: String,
    pub image: Vec<u8>,
    pub updated_at: String,
}

pub async fn put_stream_preview(
    channel_id: &str,
    user_id: &str,
    content_type: &str,
    image: &[u8],
) -> Result<()> {
    if !valid_stream_preview(content_type, image) {
        return Err(create_error!(InvalidOperation));
    }
    let session = get_current_voice_session(user_id)
        .await?
        .ok_or_else(|| create_error!(InvalidOperation))?;
    // Check current authority atomically so stop/leave cannot race an upload.
    let script = format!(
        "{VALIDATE_STREAM_SESSION}{}",
        r#"
        if operation_id ~= ARGV[1] or not stream_session_active(operation_id, ARGV[2]) then return 0 end
        redis.call('HSET', KEYS[2], 'content_type', ARGV[3], 'image', ARGV[4], 'updated_at', ARGV[5], 'operation_id', operation_id)
        redis.call('EXPIRE', KEYS[2], tonumber(ARGV[6]))
        return 1
    "#
    );
    let saved: i64 = cmd("EVAL")
        .arg(script)
        .arg(2)
        .arg(voice_current_key(user_id))
        .arg(stream_preview_key(channel_id, user_id))
        .arg(&session.operation_id)
        .arg(channel_id)
        .arg(content_type)
        .arg(image)
        .arg(iso8601_timestamp::Timestamp::now_utc().to_string())
        .arg(STREAM_PREVIEW_TTL_SECONDS)
        .query_async(&mut get_connection().await?.into_inner())
        .await
        .to_internal_error()?;
    if saved != 1 {
        return Err(create_error!(InvalidOperation));
    }
    Ok(())
}

pub async fn get_stream_preview(channel_id: &str, user_id: &str) -> Result<Option<StreamPreview>> {
    // Validation and stale cleanup share one Redis operation, including expired sessions.
    let result: Option<(Option<String>, Option<Vec<u8>>, Option<String>)> = cmd("EVAL")
        .arg(preview_read_script(true))
        .arg(2)
        .arg(voice_current_key(user_id))
        .arg(stream_preview_key(channel_id, user_id))
        .arg(channel_id)
        .query_async(&mut get_connection().await?.into_inner())
        .await
        .to_internal_error()?;
    Ok(match result {
        Some((Some(content_type), Some(image), Some(updated_at))) => Some(StreamPreview {
            content_type,
            image,
            updated_at,
        }),
        _ => None,
    })
}

/// Remove a preview only if its owning stream is stale, without reading image bytes.
pub async fn prune_stream_preview(channel_id: &str, user_id: &str) -> Result<()> {
    let _: bool = cmd("EVAL")
        .arg(preview_read_script(false))
        .arg(2)
        .arg(voice_current_key(user_id))
        .arg(stream_preview_key(channel_id, user_id))
        .arg(channel_id)
        .query_async(&mut get_connection().await?.into_inner())
        .await
        .to_internal_error()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_type_signature_length_and_limit() {
        let jpeg = [0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9];
        let webp = b"RIFF\x0c\x00\x00\x00WEBPVP8 \x00\x00\x00\x00";
        assert!(valid_stream_preview("image/jpeg", &jpeg));
        assert!(valid_stream_preview("image/webp", webp));
        assert!(!valid_stream_preview("image/webp", &jpeg));
        assert!(!valid_stream_preview("image/jpeg", webp));
        assert!(!valid_stream_preview("image/png", &jpeg));
        assert!(!valid_stream_preview("image/webp", &webp[..12]));
        assert!(!valid_stream_preview("image/jpeg", &[0xff, 0xd8, 0xff]));
        assert!(!valid_stream_preview(
            "image/jpeg",
            &vec![0; MAX_STREAM_PREVIEW_BYTES + 1]
        ));
        assert!(!valid_stream_preview("image/jpeg", &[]));
    }

    #[test]
    fn keys_separate_channel_and_streamer() {
        assert_eq!(
            stream_preview_key("channel", "user"),
            "voice_stream_preview:channel:user"
        );
        assert_ne!(
            stream_preview_key("channel", "user"),
            stream_preview_key("other", "user")
        );
        assert_ne!(
            stream_preview_key("channel", "user"),
            stream_preview_key("channel", "other")
        );
    }
}
