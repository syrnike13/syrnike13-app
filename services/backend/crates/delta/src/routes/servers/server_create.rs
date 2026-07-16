use syrnike_config::config;
use syrnike_database::{Database, Member, Server, User};
use syrnike_models::v0;
use syrnike_result::{Result, create_error};

use rocket::State;
use rocket::serde::json::Json;
use validator::Validate;

/// # Create Server
///
/// Create a new server.
#[openapi(tag = "Server Information")]
#[post("/create", data = "<data>")]
pub async fn create_server(
    db: &State<Database>,
    user: User,
    data: Json<v0::DataCreateServer>,
) -> Result<Json<v0::CreateServerLegacyResponse>> {
    if user.bot.is_some() {
        return Err(create_error!(IsBot));
    }

    let config = config().await;

    if !config
        .features
        .limits
        .global
        .restrict_server_creation
        .is_empty()
        && !config
            .features
            .limits
            .global
            .restrict_server_creation
            .contains(&user.id)
    {
        return Err(create_error!(CantCreateServers));
    }

    let data = data.into_inner();
    data.validate().map_err(|error| {
        create_error!(FailedValidation {
            error: error.to_string()
        })
    })?;

    user.can_acquire_server(db).await?;

    let (server, channels) = Server::create(db, data, &user, true).await?;
    let (member, channels) = Member::create(db, &server, &user, Some(channels), false).await?;

    Ok(Json(v0::CreateServerLegacyResponse {
        server: server.into(),
        member: member.into(),
        channels: channels.into_iter().map(|channel| channel.into()).collect(),
    }))
}
