// use syrnike_database::util::reference::Reference;
use rocket::serde::json::Json;
use rocket::State;
use syrnike_database::{Database, User, AMQP};
use syrnike_models::v0;
use syrnike_result::{create_error, Result};

/// # Send Friend Request
///
/// Send a friend request to another user.
#[openapi(tag = "Relationships")]
#[post("/friend", data = "<data>")]
pub async fn send_friend_request(
    db: &State<Database>,
    amqp: &State<AMQP>,
    mut user: User,
    data: Json<v0::DataSendFriendRequest>,
) -> Result<Json<v0::User>> {
    let mut target = if let Some((username, discriminator)) = data.username.split_once('#') {
        db.fetch_user_by_username(username, discriminator).await?
    } else {
        let discriminators = db.fetch_discriminators_in_use(&data.username).await?;

        match discriminators.as_slice() {
            [discriminator] => {
                db.fetch_user_by_username(&data.username, discriminator)
                    .await?
            }
            [] => return Err(create_error!(NotFound)),
            _ => return Err(create_error!(InvalidProperty)),
        }
    };

    if user.bot.is_some() || target.bot.is_some() {
        return Err(create_error!(IsBot));
    }

    user.add_friend(db, amqp, &mut target).await?;
    Ok(Json(target.into(db, &user).await))
}
