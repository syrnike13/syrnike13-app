use crate::{
    models::{Channel, User},
    voice::RoomMetadata,
    Database,
};
use livekit_api::{
    access_token::{AccessToken, VideoGrants},
    services::room::{CreateRoomOptions, RoomClient as InnerRoomClient, UpdateParticipantOptions},
};
use livekit_protocol::{ParticipantInfo, ParticipantPermission, Room};
use std::{collections::HashMap, time::Duration};
use syrnike_config::{config, LiveKitNode};
use syrnike_permissions::{ChannelPermission, PermissionValue};
use syrnike_result::{create_error, Result, ToSyrnikeError};

use super::{desktop_native_voice_identities, get_allowed_sources};

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

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VoiceTransportCleanupReport {
    pub failures: Vec<VoiceTransportCleanupFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VoiceTransportCleanupFailure {
    ListRooms {
        node: String,
    },
    ListParticipants {
        node: String,
        room: String,
    },
    RemoveParticipant {
        node: String,
        room: String,
        identity: String,
    },
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
        let room = self.get_node(node)?;

        let limits = user.limits().await;
        let allowed_sources = get_allowed_sources(&limits, permissions);

        AccessToken::with_api_key(&room.node.key, &room.node.secret)
            .with_name(&format!("{}#{}", user.username, user.discriminator))
            .with_identity(identity)
            .with_metadata(
                &serde_json::to_string(&user.clone().into(db, None).await).to_internal_error()?,
            )
            .with_ttl(NATIVE_VOICE_TOKEN_TTL)
            .with_grants(VideoGrants {
                room_join: true,
                can_publish: true,
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
        user: &User,
        channel_id: &str,
        new_permissions: ParticipantPermission,
    ) -> Result<ParticipantInfo> {
        let room = self.get_node(node)?;

        room.client
            .update_participant(
                channel_id,
                &user.id,
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

    pub async fn remove_user_from_all_rooms(&self, user_id: &str) -> VoiceTransportCleanupReport {
        let mut report = VoiceTransportCleanupReport::default();

        for (node_name, room) in &self.rooms {
            let rooms = match room.client.list_rooms(Vec::new()).await {
                Ok(rooms) => rooms,
                Err(error) => {
                    log::warn!(
                        "Failed to list LiveKit rooms on node {node_name} while enforcing single voice session for user {user_id}: {error}"
                    );
                    report
                        .failures
                        .push(VoiceTransportCleanupFailure::ListRooms {
                            node: node_name.clone(),
                        });
                    continue;
                }
            };

            for livekit_room in rooms {
                if livekit_room.name.is_empty() {
                    continue;
                }

                let participants = match room.client.list_participants(&livekit_room.name).await {
                    Ok(participants) => participants,
                    Err(error) => {
                        log::warn!(
                            "Failed to list LiveKit participants in room {} on node {node_name} while enforcing single voice session for user {user_id}: {error}",
                            livekit_room.name
                        );
                        report
                            .failures
                            .push(VoiceTransportCleanupFailure::ListParticipants {
                                node: node_name.clone(),
                                room: livekit_room.name.clone(),
                            });
                        continue;
                    }
                };

                for identity in std::iter::once(user_id.to_string())
                    .chain(desktop_native_voice_identities(user_id))
                {
                    if !participants
                        .iter()
                        .any(|participant| participant.identity == identity)
                    {
                        continue;
                    }

                    if let Err(error) = room
                        .client
                        .remove_participant(&livekit_room.name, &identity)
                        .await
                    {
                        log::warn!(
                            "Failed to remove LiveKit participant {identity} from room {} on node {node_name}: {error}",
                            livekit_room.name
                        );
                        report
                            .failures
                            .push(VoiceTransportCleanupFailure::RemoveParticipant {
                                node: node_name.clone(),
                                room: livekit_room.name.clone(),
                                identity,
                            });
                    }
                }
            }
        }

        report
    }

    pub async fn delete_room(&self, node: &str, channel_id: &str) -> Result<()> {
        let room = self.get_node(node)?;

        room.client
            .delete_room(channel_id)
            .await
            .to_internal_error()
    }
}
