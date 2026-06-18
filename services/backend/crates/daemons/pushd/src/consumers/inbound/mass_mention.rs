use std::{
    collections::{HashMap, HashSet},
    hash::RandomState,
    sync::Arc,
};

use crate::utils::{render_notification_content, Consumer};
use anyhow::Result;
use async_trait::async_trait;
use lapin::{message::Delivery, Channel, Connection};
use syrnike_database::{
    events::rabbit::*, util::bulk_permissions::BulkDatabasePermissionQuery, Database, Member,
    MessageFlagsValue,
};
use syrnike_models::v0::{MessageFlags, PushNotification};
use syrnike_result::ToSyrnikeError;

#[derive(Clone)]
#[allow(unused)]
pub struct MassMessageConsumer {
    db: Database,
    authifier_db: authifier::Database,
    connection: Arc<Connection>,
    channel: Arc<Channel>,
}

impl MassMessageConsumer {
    async fn fire_notification_for_users(
        &self,
        push: &PushNotification,
        users: &[String],
    ) -> Result<()> {
        if let Ok(sessions) = self
            .authifier_db
            .find_sessions_with_subscription(users)
            .await
        {
            let config = syrnike_config::config().await;
            for session in sessions {
                if let Some(sub) = session.subscription {
                    let mut sendable = PayloadToService {
                        notification: PayloadKind::MessageNotification(push.clone()),
                        token: sub.auth,
                        user_id: session.user_id,
                        session_id: session.id,
                        extras: HashMap::new(),
                    };

                    let routing_key = match sub.endpoint.as_str() {
                        "apn" => &config.pushd.apn.queue,
                        "fcm" => &config.pushd.fcm.queue,
                        endpoint => {
                            sendable.extras.insert("p256dh".to_string(), sub.p256dh);
                            sendable
                                .extras
                                .insert("endpoint".to_string(), endpoint.to_string());

                            &config.pushd.vapid.queue
                        }
                    };

                    let payload = serde_json::to_string(&sendable)?;

                    self.publish_message(payload.as_bytes(), &config.pushd.exchange, routing_key)
                        .await?;
                }
            }
        }

        Ok(())
    }
}

async fn visible_unmentioned_member_ids(
    query: &BulkDatabasePermissionQuery<'_>,
    chunk: &[Member],
    existing_mentions: &HashSet<String, RandomState>,
) -> Vec<String> {
    let mut q = query.clone().members(chunk);
    q.members_can_see_channel()
        .await
        .iter()
        .filter_map(|(uid, viewable)| {
            if *viewable && !existing_mentions.contains(uid) {
                Some(uid.clone())
            } else {
                None
            }
        })
        .collect()
}

#[async_trait]
impl Consumer for MassMessageConsumer {
    async fn create(
        db: Database,
        authifier_db: authifier::Database,
        connection: Arc<Connection>,
        channel: Arc<Channel>,
    ) -> Self {
        Self {
            db,
            authifier_db,
            connection,
            channel,
        }
    }

    fn channel(&self) -> &Arc<Channel> {
        &self.channel
    }

    /// This consumer handles adding mentions for all the users affected by a mass mention ping, and then sends out push notifications.
    async fn consume(&self, delivery: Delivery) -> Result<()> {
        let mut payload: MassMessageSentPayload = serde_json::from_slice(&delivery.data)?;
        let config = syrnike_config::config().await;

        for push in payload.notifications.iter_mut() {
            if let Ok(body) = render_notification_content(push, &self.db)
                .await
                .to_internal_error()
            {
                push.raw_body = Some(push.body.clone());
                push.body = body;
            }
        }

        debug!("Received mass message event");

        // We should only ever receive clumped messages from a single channel, so it's safe to reuse this many times.
        let mut query: Option<BulkDatabasePermissionQuery<'_>> = None;
        let query_db = self.db.clone();

        for push in payload.notifications {
            if query.is_none() {
                query = Some(
                    BulkDatabasePermissionQuery::from_server_id(&query_db, &payload.server_id)
                        .await
                        .from_channel_id(push.channel.id().to_string()) // wrong channel model, so fetch the right one
                        .await,
                );
            }

            let existing_mentions: HashSet<String, RandomState> =
                if let Some(ref mentions) = push.message.mentions {
                    HashSet::from_iter(mentions.iter().cloned())
                } else {
                    HashSet::new()
                };

            // KNOWN QUIRK: if you mention @online and role(s), the offline members with the role(s) wont get pinged
            if let Some(ref query) = query {
                let flags = MessageFlagsValue(push.message.flags);
                if flags.has(MessageFlags::MentionsEveryone) {
                    let mut db_query = self
                        .db
                        .fetch_all_members_chunked(&payload.server_id)
                        .await?;

                    let mut exhausted = false;
                    let message_ids = vec![push.message.id.clone()];
                    loop {
                        let mut chunk: Vec<Member> = vec![];
                        for _ in 0..config.pushd.mass_mention_chunk_size {
                            if let Some(member) = db_query.next().await {
                                chunk.push(member);
                            } else {
                                exhausted = true;
                                break;
                            }
                        }

                        let viewing_members =
                            visible_unmentioned_member_ids(query, &chunk, &existing_mentions).await;

                        if let Err(err) = self
                            .db
                            .add_mention_to_many_unreads(
                                push.channel.id(),
                                &viewing_members,
                                &message_ids,
                            )
                            .await
                        {
                            syrnike_config::capture_error(&err);
                        }

                        // ignore anyone in this list
                        let online_users = syrnike_presence::filter_online(&viewing_members).await;
                        let target_users: Vec<String> = viewing_members
                            .iter()
                            .filter(|id| !online_users.contains(*id))
                            .cloned()
                            .collect();

                        debug!(
                            "Userids after filter: {:?} (online: {:?}",
                            target_users, online_users
                        );

                        self.fire_notification_for_users(&push, &target_users)
                            .await?;

                        if exhausted {
                            break;
                        }
                    }
                } else if let Some(roles) = &push.message.role_mentions {
                    // role mentions
                    let mut role_members = self
                        .db
                        .fetch_all_members_with_roles_chunked(&payload.server_id, roles)
                        .await?;

                    let mut chunk = vec![];
                    let mut exhausted = false;

                    while !exhausted {
                        chunk.clear();

                        for _ in 0..config.pushd.mass_mention_chunk_size {
                            if let Some(member) = role_members.next().await {
                                chunk.push(member);
                            } else {
                                exhausted = true;
                                break;
                            }
                        }

                        let viewing_members =
                            visible_unmentioned_member_ids(query, &chunk, &existing_mentions).await;

                        debug!("viewing members: {:?}", viewing_members);

                        let online = syrnike_presence::filter_online(&viewing_members).await;
                        debug!("online: {:?}", online);

                        let targets: Vec<String> = viewing_members
                            .iter()
                            .filter(|m| !online.contains(*m))
                            .cloned()
                            .collect();

                        debug!("targets: {:?}", targets);

                        self.fire_notification_for_users(&push, &targets).await?;
                    }
                }
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use syrnike_database::{Channel, DatabaseInfo, Member, MemberCompositeKey, Role, Server, User};
    use syrnike_permissions::{ChannelPermission, OverrideField};

    use super::*;

    #[tokio::test]
    async fn everyone_mentions_only_target_members_who_can_view_the_channel() {
        let db = DatabaseInfo::Reference
            .connect()
            .await
            .expect("reference database");
        let server_id = "server-1".to_string();
        let channel_id = "channel-1".to_string();
        let message_id = "message-1".to_string();
        let visible_user_id = "user-visible".to_string();
        let hidden_user_id = "user-hidden".to_string();
        let viewer_role_id = "role-viewer".to_string();
        let view_channel = ChannelPermission::ViewChannel as i64;

        let visible_user = User {
            id: visible_user_id.clone(),
            username: "visible".to_string(),
            discriminator: "0001".to_string(),
            ..Default::default()
        };
        let hidden_user = User {
            id: hidden_user_id.clone(),
            username: "hidden".to_string(),
            discriminator: "0002".to_string(),
            ..Default::default()
        };
        db.insert_user(&visible_user).await.unwrap();
        db.insert_user(&hidden_user).await.unwrap();

        let server = Server {
            id: server_id.clone(),
            owner: "owner-1".to_string(),
            name: "Server".to_string(),
            description: None,
            channels: vec![channel_id.clone()],
            categories: None,
            system_messages: None,
            roles: HashMap::from([(
                viewer_role_id.clone(),
                Role {
                    id: viewer_role_id.clone(),
                    name: "Viewer".to_string(),
                    permissions: OverrideField::default(),
                    colour: None,
                    hoist: false,
                    mentionable: true,
                    rank: 0,
                    icon: None,
                },
            )]),
            default_permissions: 0,
            icon: None,
            banner: None,
            flags: None,
            nsfw: false,
            analytics: false,
            discoverable: false,
        };
        let channel = Channel::TextChannel {
            id: channel_id.clone(),
            server: server_id.clone(),
            name: "hidden".to_string(),
            description: None,
            icon: None,
            last_message_id: None,
            default_permissions: Some(OverrideField {
                a: 0,
                d: view_channel,
            }),
            role_permissions: HashMap::from([(
                viewer_role_id.clone(),
                OverrideField {
                    a: view_channel,
                    d: 0,
                },
            )]),
            nsfw: false,
            voice: None,
            slowmode: None,
        };
        let visible_member = Member {
            id: MemberCompositeKey {
                server: server_id.clone(),
                user: visible_user_id.clone(),
            },
            roles: vec![viewer_role_id],
            ..Default::default()
        };
        let hidden_member = Member {
            id: MemberCompositeKey {
                server: server_id,
                user: hidden_user_id.clone(),
            },
            ..Default::default()
        };
        let query = BulkDatabasePermissionQuery::new(&db, server).channel(&channel);

        let targets = visible_unmentioned_member_ids(
            &query,
            &[visible_member, hidden_member],
            &HashSet::new(),
        )
        .await;
        db.add_mention_to_many_unreads(&channel_id, &targets, &[message_id.clone()])
            .await
            .unwrap();

        assert_eq!(targets, vec![visible_user_id.clone()]);
        let visible_unread = db
            .fetch_unread(&visible_user_id, &channel_id)
            .await
            .unwrap()
            .expect("visible unread");
        assert_eq!(visible_unread.mentions, Some(vec![message_id]));
        assert!(db
            .fetch_unread(&hidden_user_id, &channel_id)
            .await
            .unwrap()
            .is_none());
    }
}
