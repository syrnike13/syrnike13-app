use rocket::State;
use rocket_empty::EmptyResponse;
use syrnike_database::{
    util::{acker, permissions::DatabasePermissionQuery, reference::Reference},
    Database, User, AMQP,
};
use syrnike_permissions::PermissionQuery;
use syrnike_result::{create_error, Result};

/// # Mark Server As Read
///
/// Mark all channels in a server as read.
#[openapi(tag = "Server Information")]
#[put("/<target>/ack")]
pub async fn ack(
    db: &State<Database>,
    amqp: &State<AMQP>,
    user: User,
    target: Reference<'_>,
) -> Result<EmptyResponse> {
    if user.bot.is_some() {
        return Err(create_error!(IsBot));
    }

    let server = target.as_server(db).await?;
    let mut query = DatabasePermissionQuery::new(db, &user).server(&server);
    if !query.are_we_a_member().await {
        return Err(create_error!(NotFound));
    }

    acker::ack_server(&user, &server, db, amqp).await?;
    Ok(EmptyResponse)
}
