use rocket::{serde::json::Json, State};
use syrnike_database::{Database, User};
use syrnike_models::v0;
use syrnike_result::Result;

/// # Fetch Direct Message Channels
///
/// This fetches your direct messages, including any DM and group DM conversations.
#[openapi(tag = "Direct Messaging")]
#[get("/dms")]
pub async fn direct_messages(db: &State<Database>, user: User) -> Result<Json<Vec<v0::Channel>>> {
    let mut channels = Vec::new();

    for channel in db.find_direct_messages(&user.id).await? {
        if !channel.has_bot_recipient(db).await? {
            channels.push(channel.into());
        }
    }

    Ok(Json(channels))
}
