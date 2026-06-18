use rocket::State;
use rocket_empty::EmptyResponse;
use syrnike_database::{
    util::{permissions::DatabasePermissionQuery, reference::Reference},
    voice::{delete_voice_channel, UserVoiceChannel, VoiceClient},
    Channel, Database, PartialChannel, ServerAuditLogAction, ServerAuditLogTarget, User, AMQP,
};
use syrnike_models::v0;
use syrnike_permissions::{calculate_channel_permissions, ChannelPermission};
use syrnike_result::{create_error, Result};

use super::voice_call_cleanup::{
    delete_group_voice_call, remove_group_member_from_voice_call,
    stop_ringing_for_removed_group_member,
};
use crate::routes::servers::audit_mutation;

/// # Close Channel
///
/// Deletes a server channel, leaves a group or closes a group.
#[openapi(tag = "Channel Information")]
#[delete("/<target>?<options..>")]
pub async fn delete(
    db: &State<Database>,
    voice_client: &State<VoiceClient>,
    amqp: &State<AMQP>,
    user: User,
    target: Reference<'_>,
    options: v0::OptionsChannelDelete,
) -> Result<EmptyResponse> {
    let mut channel = target.as_channel(db).await?;
    let mut query = DatabasePermissionQuery::new(db, &user).channel(&channel);
    let permissions = calculate_channel_permissions(&mut query).await;

    permissions.throw_if_lacking_channel_permission(ChannelPermission::ViewChannel)?;

    #[allow(deprecated)]
    match &channel {
        Channel::SavedMessages { .. } => Err(create_error!(NoEffect))?,
        Channel::DirectMessage { .. } => {
            channel
                .update(
                    db,
                    PartialChannel {
                        active: Some(false),
                        ..Default::default()
                    },
                    vec![],
                )
                .await?
        }
        Channel::Group {
            owner, recipients, ..
        } => {
            let deletes_group = owner == &user.id
                && recipients
                    .iter()
                    .all(|recipient_id| recipient_id == &user.id);

            channel
                .remove_user_from_group(
                    db,
                    amqp,
                    &user,
                    None,
                    options.leave_silently.unwrap_or_default(),
                )
                .await?;

            if deletes_group {
                delete_group_voice_call(db, voice_client, amqp, &channel).await?;
            } else {
                stop_ringing_for_removed_group_member(amqp, channel.id(), &user.id).await?;
                remove_group_member_from_voice_call(db, voice_client, amqp, &channel, &user.id)
                    .await?;
            }
        }
        Channel::TextChannel { .. } => {
            permissions.throw_if_lacking_channel_permission(ChannelPermission::ManageChannel)?;
            let server_id = channel.server().expect("server channel").to_string();
            let channel_id = channel.id().to_string();
            let mut audit = audit_mutation::insert_pending_audit(
                db,
                server_id,
                user.id.clone(),
                ServerAuditLogAction::ChannelDelete,
                ServerAuditLogTarget::Channel {
                    id: channel_id.clone(),
                },
                None,
                audit_mutation::audit_changes(vec![(
                    "channel",
                    audit_mutation::audit_change(Some(channel.clone()), None::<Channel>)?,
                )]),
            )
            .await?;

            if let Err(error) = channel.delete(db).await {
                return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
            }

            if let Err(error) =
                delete_voice_channel(voice_client, &UserVoiceChannel::from_channel(&channel)).await
            {
                return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
            }

            audit.mark_succeeded(db).await?;
        }
    };

    Ok(EmptyResponse)
}

#[cfg(test)]
mod test {
    use crate::{rocket, util::test::TestHarness};
    use rocket::http::{Header, Status};
    use syrnike_database::{events::client::EventV1, Channel};
    use syrnike_models::v0::DataCreateGroup;

    #[rocket::async_test]
    async fn success_delete_group() {
        let mut harness = TestHarness::new().await;
        let (_, session, user) = harness.new_user().await;

        let group = Channel::create_group(
            &harness.db,
            DataCreateGroup {
                ..Default::default()
            },
            user.id.clone(),
        )
        .await
        .expect("`Channel`");

        let response = harness
            .client
            .delete(format!("/channels/{}", group.id()))
            .header(Header::new("x-session-token", session.token.to_string()))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::NoContent);
        drop(response);

        harness
            .wait_for_event(group.id(), |event| match event {
                EventV1::ChannelDelete { id, .. } => id == group.id(),
                _ => false,
            })
            .await;
    }

    // TEST: member leaves group (no delete)
    // TEST: no effect with saved messages
    // TEST: DM set to inactive

    #[rocket::async_test]
    async fn success_delete_channel() {
        let mut harness = TestHarness::new().await;
        let (_, session, user) = harness.new_user().await;
        let (_, channels) = harness.new_server(&user).await;
        let response = TestHarness::with_session(
            session,
            harness
                .client
                .delete(format!("/channels/{}", channels[0].id())),
        )
        .await;
        assert_eq!(response.status(), Status::NoContent);
        drop(response);
        harness
            .wait_for_event(channels[0].id(), |event| match event {
                EventV1::ChannelDelete { id, .. } => id == channels[0].id(),
                _ => false,
            })
            .await;
    }
}
