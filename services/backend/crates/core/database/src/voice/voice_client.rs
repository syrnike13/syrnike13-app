use crate::{
    models::{Channel, User},
    voice::RoomMetadata,
    Database,
};
use livekit_api::{
    access_token::{AccessToken, VideoGrants},
    services::{
        room::{CreateRoomOptions, RoomClient as InnerRoomClient, UpdateParticipantOptions},
        ServiceError, TwirpError, TwirpErrorCode,
    },
};
use livekit_protocol::{ParticipantInfo, ParticipantPermission, Room};
use std::{collections::HashMap, time::Duration};
use syrnike_config::{config, LiveKitNode};
use syrnike_permissions::{ChannelPermission, PermissionValue};
use syrnike_result::{create_error, Result, ToSyrnikeError};

use super::get_allowed_sources;

const NATIVE_VOICE_TOKEN_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Debug)]
pub struct RoomClient {
    pub client: InnerRoomClient,
    pub node: LiveKitNode,
}

#[derive(Debug)]
pub struct VoiceClient {
    pub rooms: HashMap<String, RoomClient>,
}

impl VoiceClient {
    pub fn new(nodes: HashMap<String, LiveKitNode>) -> Self {
        Self {
            rooms: nodes
                .into_iter()
                .map(|(name, node)| {
                    (
                        name,
                        RoomClient {
                            client: InnerRoomClient::with_api_key(
                                &node.url,
                                &node.key,
                                &node.secret,
                            ),
                            node,
                        },
                    )
                })
                .collect(),
        }
    }

    pub fn is_enabled(&self) -> bool {
        !self.rooms.is_empty()
    }

    pub async fn from_syrnike_config() -> Self {
        let config = config().await;

        Self::new(config.api.livekit.nodes.clone())
    }

    pub fn get_node(&self, name: &str) -> Result<&RoomClient> {
        self.rooms
            .get(name)
            .ok_or_else(|| create_error!(UnknownNode))
    }

    pub async fn create_token_for_identity(
        &self,
        node: &str,
        db: &Database,
        user: &User,
        identity: &str,
        permissions: PermissionValue,
        channel: &Channel,
    ) -> Result<String> {
        self.create_token_for_identity_with_attributes(
            node,
            db,
            user,
            identity,
            permissions,
            channel,
            std::iter::empty::<(String, String)>(),
        )
        .await
    }

    pub async fn create_token_for_identity_with_attributes<I, K, V>(
        &self,
        node: &str,
        db: &Database,
        user: &User,
        identity: &str,
        permissions: PermissionValue,
        channel: &Channel,
        attributes: I,
    ) -> Result<String>
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        let room = self.get_node(node)?;

        let limits = user.limits().await;
        let allowed_sources = get_allowed_sources(&limits, permissions);
        let can_publish = !allowed_sources.is_empty();

        AccessToken::with_api_key(&room.node.key, &room.node.secret)
            .with_name(&format!("{}#{}", user.username, user.discriminator))
            .with_identity(identity)
            .with_metadata(
                &serde_json::to_string(&user.clone().into(db, None).await).to_internal_error()?,
            )
            .with_attributes(attributes)
            .with_ttl(NATIVE_VOICE_TOKEN_TTL)
            .with_grants(VideoGrants {
                room_join: true,
                can_publish,
                can_publish_data: false,
                can_publish_sources: allowed_sources
                    .into_iter()
                    .map(ToString::to_string)
                    .collect(),
                can_subscribe: permissions.has_channel_permission(ChannelPermission::Listen),
                room: channel.id().to_string(),
                ..Default::default()
            })
            .to_jwt()
            .to_internal_error()
    }

    pub async fn create_room(&self, node: &str, channel: &Channel) -> Result<Room> {
        let room = self.get_node(node)?;

        let metadata = RoomMetadata {
            server: channel.server().map(|id| id.to_string()),
        };

        room.client
            .create_room(
                channel.id(),
                CreateRoomOptions {
                    empty_timeout: 5 * 60, // 5 minutes,
                    metadata: serde_json::to_string(&metadata).to_internal_error()?,
                    ..Default::default()
                },
            )
            .await
            .to_internal_error()
    }

    pub async fn update_permissions(
        &self,
        node: &str,
        participant_identity: &str,
        channel_id: &str,
        new_permissions: ParticipantPermission,
    ) -> Result<ParticipantInfo> {
        let room = self.get_node(node)?;

        room.client
            .update_participant(
                channel_id,
                participant_identity,
                UpdateParticipantOptions {
                    permission: Some(new_permissions),
                    ..Default::default()
                },
            )
            .await
            .to_internal_error()
    }

    pub async fn remove_user(&self, node: &str, user_id: &str, channel_id: &str) -> Result<()> {
        let room = self.get_node(node)?;

        room.client
            .remove_participant(channel_id, user_id)
            .await
            .to_internal_error()
    }

    pub async fn list_room_participants(
        &self,
        node: &str,
        channel_id: &str,
    ) -> Result<Option<Vec<ParticipantInfo>>> {
        let room = self.get_node(node)?;

        match room.client.list_participants(channel_id).await {
            Ok(participants) => Ok(Some(participants)),
            Err(ServiceError::Twirp(TwirpError::Twirp(error)))
                if error.code == TwirpErrorCode::NOT_FOUND =>
            {
                Ok(None)
            }
            Err(error) => {
                log::warn!(
                    "Failed to list LiveKit participants for channel {channel_id} on node {node}: {error}"
                );
                Err(create_error!(InternalError))
            }
        }
    }

    pub async fn delete_room(&self, node: &str, channel_id: &str) -> Result<()> {
        let room = self.get_node(node)?;

        match room.client.delete_room(channel_id).await {
            Ok(_) => Ok(()),
            Err(ServiceError::Twirp(TwirpError::Twirp(error)))
                if error.code == TwirpErrorCode::NOT_FOUND =>
            {
                Ok(())
            }
            Err(error) => {
                log::warn!(
                    "Failed to delete LiveKit room for channel {channel_id} on node {node}: {error}"
                );
                Err(create_error!(InternalError))
            }
        }
    }
}
