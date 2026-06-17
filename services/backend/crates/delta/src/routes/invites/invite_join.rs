use rocket::{serde::json::Json, State};
use syrnike_database::{util::reference::Reference, Channel, Database, Invite, Member, User, AMQP};
use syrnike_models::v0::{self, InviteJoinResponse};
use syrnike_result::{create_error, Result};

use crate::routes::voice_call_member_sync::send_active_group_voice_call_to_new_member;

/// # Join Invite
///
/// Join an invite by its ID
#[openapi(tag = "Invites")]
#[post("/<target>")]
pub async fn join(
    db: &State<Database>,
    amqp: &State<AMQP>,
    user: User,
    target: Reference<'_>,
) -> Result<Json<v0::InviteJoinResponse>> {
    if user.bot.is_some() {
        return Err(create_error!(IsBot));
    }

    user.can_acquire_server(db).await?;

    let invite = target.as_invite(db).await?;
    match &invite {
        Invite::Server { server, .. } => {
            let server = db.fetch_server(server).await?;
            let (member, channels) = Member::create(db, &server, &user, None).await?;

            Ok(Json(InviteJoinResponse::Server {
                channels: channels.into_iter().map(|c| c.into()).collect(),
                member: member.into(),
                server: server.into(),
            }))
        }
        Invite::Group {
            channel, creator, ..
        } => {
            let mut channel = db.fetch_channel(channel).await?;
            if channel.has_bot_recipient(db).await? {
                return Err(create_error!(NotFound));
            }

            channel.add_user_to_group(db, amqp, &user, creator).await?;
            send_active_group_voice_call_to_new_member(&user.id, &channel).await?;
            if let Channel::Group { recipients, .. } = &channel {
                Ok(Json(InviteJoinResponse::Group {
                    users: User::fetch_many_ids_as_mutuals(db, &user, recipients).await?,
                    channel: channel.into(),
                }))
            } else {
                unreachable!()
            }
        }
    }
}
