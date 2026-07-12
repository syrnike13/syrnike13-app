use rocket::State;
use rocket_empty::EmptyResponse;
use syrnike_database::{
    util::{permissions::DatabasePermissionQuery, reference::Reference},
    voice::{
        delete_voice_channel, get_voice_channel_members,
        remove_temporary_server_member_after_voice_disconnect, UserVoiceChannel, VoiceClient,
    },
    Channel, Database, PartialChannel, ServerAuditLogAction, ServerAuditLogTarget, User,
};
use syrnike_models::v0;
use syrnike_permissions::{calculate_channel_permissions, ChannelPermission};
use syrnike_result::{create_error, Result};

use super::voice_call_cleanup::{
    delete_group_voice_call, remove_group_member_from_voice_call,
    stop_ringing_for_removed_group_member,
};
use super::OptionalAmqp;
use crate::routes::servers::audit_mutation;

/// # Close Channel
///
/// Deletes a server channel, leaves a group or closes a group.
#[openapi(tag = "Channel Information")]
#[delete("/<target>?<options..>")]
pub async fn delete(
    db: &State<Database>,
    voice_client: &State<VoiceClient>,
    amqp: OptionalAmqp<'_>,
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
            let amqp = amqp.required("AMQP state must be managed for group channel deletes");
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
                remove_group_member_from_voice_call(db, amqp, &channel, &user.id).await?;
            }
        }
        Channel::TextChannel { .. } => {
            permissions.throw_if_lacking_channel_permission(ChannelPermission::ManageChannel)?;
            let server_id = channel.server().expect("server channel").to_string();
            let channel_id = channel.id().to_string();
            let had_voice = channel.voice().is_some();
            let voice_channel = UserVoiceChannel::from_channel(&channel);
            let connected_voice_members = if had_voice {
                get_voice_channel_members(&voice_channel)
                    .await?
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
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

            if had_voice {
                if let Err(error) = delete_voice_channel(voice_client, &voice_channel).await {
                    return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
                }

                for member_id in connected_voice_members {
                    if let Err(error) = remove_temporary_server_member_after_voice_disconnect(
                        db,
                        &voice_channel,
                        &member_id,
                    )
                    .await
                    {
                        return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
                    }
                }
            }

            audit.mark_succeeded(db).await?;
        }
    };

    Ok(EmptyResponse)
}

#[cfg(test)]
fn routes_under_test() -> Vec<rocket::Route> {
    routes![delete]
}

#[cfg(test)]
mod test {
    use std::collections::HashMap;

    use crate::{rocket, util::test::TestHarness};
    use authifier::{
        models::{Account, EmailVerification, Session},
        Authifier,
    };
    use rocket::http::{Header, Status};
    use rocket::local::asynchronous::Client;
    use syrnike_database::{events::client::EventV1, Channel};
    use syrnike_database::{
        fixture, voice::VoiceClient, Database, DatabaseInfo, ServerAuditLogAction,
        ServerAuditLogQuery, ServerAuditLogStatus, ServerAuditLogTarget,
    };
    use syrnike_models::v0::DataCreateGroup;
    use ulid::Ulid;

    struct ChannelDeleteTestContext {
        client: Client,
        db: Database,
        authifier: Authifier,
    }

    impl ChannelDeleteTestContext {
        async fn new() -> Self {
            let db = DatabaseInfo::Reference
                .connect()
                .await
                .expect("reference database");
            let authifier = db.clone().to_authifier().await;
            let client = Client::tracked(
                rocket::build()
                    .mount("/channels", super::routes_under_test())
                    .manage(authifier.clone())
                    .manage(db.clone())
                    .manage(VoiceClient::new(HashMap::new())),
            )
            .await
            .expect("valid rocket instance");

            Self {
                client,
                db,
                authifier,
            }
        }

        async fn account_from_user(&self, id: String) -> (Account, Session) {
            let account = Account {
                id,
                email: format!("{}@syrnike13.ru", Ulid::new()),
                password: Default::default(),
                email_normalised: Default::default(),
                deletion: None,
                disabled: false,
                lockout: None,
                mfa: Default::default(),
                password_reset: None,
                verification: EmailVerification::Verified,
            };

            self.authifier
                .database
                .save_account(&account)
                .await
                .expect("account saved");

            let session = account
                .create_session(&self.authifier, String::new())
                .await
                .expect("session created");

            (account, session)
        }
    }

    #[rocket::async_test]
    async fn server_channel_delete_writes_audit_entry() {
        let context = ChannelDeleteTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            owner user 0
            channel channel 3
            server server 4);

        let (_, owner_session) = context.account_from_user(owner.id.clone()).await;
        let channel_id = channel.id().to_string();

        let response = context
            .client
            .delete(format!("/channels/{channel_id}"))
            .header(Header::new(
                "x-session-token",
                owner_session.token.to_string(),
            ))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::NoContent);
        drop(response);

        let entries = context
            .db
            .fetch_server_audit_logs(
                &server.id,
                ServerAuditLogQuery {
                    action: Some(ServerAuditLogAction::ChannelDelete),
                    target_type: Some("Channel".to_string()),
                    target_id: Some(channel_id.clone()),
                    limit: 50,
                    ..Default::default()
                },
            )
            .await
            .expect("audit entries fetched");

        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.actor_id, owner.id);
        assert_eq!(entry.status, ServerAuditLogStatus::Succeeded);
        assert_eq!(
            entry.target,
            ServerAuditLogTarget::Channel { id: channel_id }
        );
        assert!(entry.changes["channel"].before.is_some());
        assert_eq!(entry.changes["channel"].after, None);
    }

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
