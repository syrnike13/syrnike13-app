use std::{collections::HashMap, sync::Arc};

use crate::utils::Consumer;

use anyhow::{anyhow, bail, Result};
use async_trait::async_trait;
use base64::{
    engine::{self},
    Engine as _,
};
use lapin::{message::Delivery, Channel as AMQPChannel, Connection};
use syrnike_database::{events::rabbit::*, util::format_display_name, Database};
use web_push::{
    ContentEncoding, IsahcWebPushClient, SubscriptionInfo, SubscriptionKeys, VapidSignatureBuilder,
    WebPushClient, WebPushError, WebPushMessageBuilder,
};

#[derive(serde::Serialize)]
struct DmCallWebPushPayload {
    #[serde(rename = "type")]
    event_type: &'static str,
    initiator_id: String,
    channel_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<String>,
    ended: bool,
    tag: String,
    title: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<String>,
}

fn dm_call_web_push_payload_body(
    alert: &DmCallPayload,
    initiator_name: Option<&str>,
    channel: Option<&syrnike_database::Channel>,
) -> Result<String> {
    let body = if alert.ended {
        None
    } else {
        let initiator_name = initiator_name
            .ok_or_else(|| anyhow!("missing initiator name for dm call start notification"))?;
        let channel =
            channel.ok_or_else(|| anyhow!("missing channel for dm call start notification"))?;

        Some(match channel {
            syrnike_database::Channel::DirectMessage { .. } => {
                format!("{initiator_name} звонит вам")
            }
            syrnike_database::Channel::Group { name, .. } => {
                format!("{initiator_name} звонит в группу {name}")
            }
            _ => bail!("Invalid DmCallStart/End channel type"),
        })
    };

    let payload = DmCallWebPushPayload {
        event_type: "DmCallStartEnd",
        initiator_id: alert.initiator_id.clone(),
        channel_id: alert.channel_id.clone(),
        started_at: alert.started_at.clone(),
        ended: alert.ended,
        tag: format!("voice-call:{}", alert.channel_id),
        title: "syrnike13",
        body,
    };

    Ok(serde_json::to_string(&payload)?)
}

#[derive(Clone)]
#[allow(unused)]
pub struct VapidOutboundConsumer {
    db: Database,
    authifier_db: authifier::Database,
    connection: Arc<Connection>,
    channel: Arc<AMQPChannel>,
    client: IsahcWebPushClient,
    pkey: Arc<Vec<u8>>,
}

#[async_trait]
impl Consumer for VapidOutboundConsumer {
    async fn create(
        db: Database,
        authifier_db: authifier::Database,
        connection: Arc<Connection>,
        channel: Arc<AMQPChannel>,
    ) -> Self {
        let config = syrnike_config::config().await;

        if config.pushd.vapid.private_key.is_empty() || config.pushd.vapid.public_key.is_empty() {
            panic!("no Vapid keys present");
        }

        let web_push_private_key = Arc::new(
            engine::general_purpose::URL_SAFE_NO_PAD
                .decode(config.pushd.vapid.private_key)
                .expect("valid `VAPID_PRIVATE_KEY`"),
        );

        Self {
            db,
            authifier_db,
            connection,
            channel,
            client: IsahcWebPushClient::new().unwrap(),
            pkey: web_push_private_key,
        }
    }

    fn channel(&self) -> &Arc<AMQPChannel> {
        &self.channel
    }

    async fn consume(&self, delivery: Delivery) -> Result<()> {
        let payload: PayloadToService = serde_json::from_slice(&delivery.data)?;

        let subscription = SubscriptionInfo {
            endpoint: payload
                .extras
                .get("endpoint")
                .ok_or_else(|| anyhow!("missing endpoint"))?
                .clone(),
            keys: SubscriptionKeys {
                auth: payload.token,
                p256dh: payload
                    .extras
                    .get("p256dh")
                    .ok_or_else(|| anyhow!("missing p256dh"))?
                    .clone(),
            },
        };

        let payload_body = match payload.notification {
            PayloadKind::FRReceived(alert) => {
                let name = alert
                    .from_user
                    .display_name
                    .or(Some(format!(
                        "{}#{}",
                        alert.from_user.username, alert.from_user.discriminator
                    )))
                    .clone()
                    .ok_or_else(|| anyhow!("missing name"))?;

                let mut body = HashMap::new();
                body.insert("body", format!("{} sent you a friend request", name));

                serde_json::to_string(&body)?
            }
            PayloadKind::FRAccepted(alert) => {
                let name = alert
                    .accepted_user
                    .display_name
                    .or(Some(format!(
                        "{}#{}",
                        alert.accepted_user.username, alert.accepted_user.discriminator
                    )))
                    .clone()
                    .ok_or_else(|| anyhow!("missing name"))?;

                let mut body = HashMap::new();
                body.insert("body", format!("{} accepted your friend request", name));

                serde_json::to_string(&body)?
            }
            PayloadKind::Generic(alert) => serde_json::to_string(&alert)?,
            PayloadKind::MessageNotification(alert) => serde_json::to_string(&alert)?,
            PayloadKind::DmCallStartEnd(alert) => {
                if alert.ended {
                    dm_call_web_push_payload_body(&alert, None, None)?
                } else {
                    let channel = self.db.fetch_channel(&alert.channel_id).await?;
                    let initiator_name = if let Some(server_id) = channel.server() {
                        format_display_name(&self.db, &alert.initiator_id, Some(server_id)).await
                    } else {
                        format_display_name(&self.db, &alert.initiator_id, None).await
                    }?;

                    dm_call_web_push_payload_body(&alert, Some(&initiator_name), Some(&channel))?
                }
            }
            PayloadKind::BadgeUpdate(_) => {
                bail!("Vapid cannot handle badge updates and they should not be sent here.");
            }
        };

        let signature = VapidSignatureBuilder::from_pem(
            std::io::Cursor::new(self.pkey.as_ref()),
            &subscription,
        )?
        .build()?;

        let mut builder = WebPushMessageBuilder::new(&subscription);
        builder.set_vapid_signature(signature);

        builder.set_payload(ContentEncoding::AesGcm, payload_body.as_bytes());

        let msg = builder.build()?;

        match self.client.send(msg).await {
            Err(WebPushError::Unauthorized) => {
                if let Err(err) = self
                    .db
                    .remove_push_subscription_by_session_id(&payload.session_id)
                    .await
                {
                    syrnike_config::capture_error(&err);
                }
            }
            res => {
                res?;
            }
        };

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;
    use syrnike_database::{events::rabbit::DmCallPayload, Channel};

    use super::dm_call_web_push_payload_body;

    fn direct_message_channel() -> Channel {
        Channel::DirectMessage {
            id: "dm-1".to_string(),
            active: true,
            recipients: vec!["caller".to_string(), "callee".to_string()],
            last_message_id: None,
        }
    }

    #[test]
    fn dm_call_start_payload_carries_service_worker_contract() {
        let alert = DmCallPayload {
            initiator_id: "caller".to_string(),
            channel_id: "dm-1".to_string(),
            started_at: Some("2026-06-12T10:00:00.000Z".to_string()),
            ended: false,
        };

        let channel = direct_message_channel();
        let raw =
            dm_call_web_push_payload_body(&alert, Some("Alice"), Some(&channel)).expect("payload");
        let value: Value = serde_json::from_str(&raw).expect("json");

        assert_eq!(value["type"], "DmCallStartEnd");
        assert_eq!(value["channel_id"], "dm-1");
        assert_eq!(value["initiator_id"], "caller");
        assert_eq!(value["started_at"], "2026-06-12T10:00:00.000Z");
        assert_eq!(value["ended"], false);
        assert_eq!(value["tag"], "voice-call:dm-1");
        assert_eq!(value["body"], "Alice звонит вам");
    }

    #[test]
    fn group_call_end_payload_closes_existing_notification_without_calling_body() {
        let alert = DmCallPayload {
            initiator_id: "caller".to_string(),
            channel_id: "group-1".to_string(),
            started_at: None,
            ended: true,
        };

        let raw = dm_call_web_push_payload_body(&alert, None, None).expect("payload");
        let value: Value = serde_json::from_str(&raw).expect("json");

        assert_eq!(value["type"], "DmCallStartEnd");
        assert_eq!(value["channel_id"], "group-1");
        assert_eq!(value["initiator_id"], "caller");
        assert_eq!(value["ended"], true);
        assert_eq!(value["tag"], "voice-call:group-1");
        assert!(value.get("body").is_none());
    }
}
