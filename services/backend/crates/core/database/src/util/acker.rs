use syrnike_permissions::{calculate_channel_permissions, ChannelPermission};
use syrnike_result::Result;

use crate::{events::client::EventV1, Channel, ChannelUnread, Database, Server, User, AMQP};

/// Persists the user's read marker for a channel and clears the mentions it covers.
///
/// The marker is written before the request returns, so every later Ready or
/// unread fetch already reflects it.
pub async fn ack_channel(
    db: &Database,
    amqp: &AMQP,
    user: &str,
    channel: &str,
    message: &str,
) -> Result<()> {
    let before = db.fetch_unread(user, channel).await?;
    #[allow(clippy::disallowed_methods)] // single entry point for read markers
    let after = db.acknowledge_message(channel, user, message).await?;

    // Apple devices show the mention count as a badge; tell pushd to refresh it.
    if mention_count(after) < mention_count(before) {
        if let Err(err) = amqp
            .ack_notification_message(user.to_string(), channel.to_string(), message.to_string())
            .await
        {
            syrnike_config::capture_error(&err);
        }
    }

    Ok(())
}

fn mention_count(unread: Option<ChannelUnread>) -> usize {
    unread
        .and_then(|unread| unread.mentions)
        .map_or(0, |mentions| mentions.len())
}

pub async fn ack_server(user: &User, server: &Server, db: &Database, amqp: &AMQP) -> Result<()> {
    let channels = db.fetch_channels(&server.channels).await?;
    let query = crate::util::permissions::DatabasePermissionQuery::new(db, user).server(server);

    for channel in channels {
        let Channel::TextChannel {
            id: channel_id,
            last_message_id: Some(channel_last_msg),
            ..
        } = &channel
        else {
            continue;
        };

        let mut q = query.clone().channel(&channel);
        if !calculate_channel_permissions(&mut q)
            .await
            .has_channel_permission(ChannelPermission::ViewChannel)
        {
            continue;
        }

        ack_channel(db, amqp, &user.id, channel_id, channel_last_msg).await?;

        EventV1::ChannelAck {
            id: channel_id.to_string(),
            user: user.id.clone(),
            message_id: channel_last_msg.clone(),
        }
        .private(user.id.clone())
        .await;
    }

    Ok(())
}
