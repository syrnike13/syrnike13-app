use syrnike_result::Result;

use crate::ReferenceDb;
use crate::{FieldsRole, FieldsServer, PartialRole, PartialServer, Role, Server};

use super::AbstractServers;

#[async_trait]
impl AbstractServers for ReferenceDb {
    /// Insert a new server into database
    async fn insert_server(&self, server: &Server) -> Result<()> {
        let mut servers = self.servers.lock().await;
        if servers.contains_key(&server.id) {
            Err(create_database_error!("insert", "server"))
        } else {
            servers.insert(server.id.to_string(), server.clone());
            Ok(())
        }
    }

    /// Fetch a server by its id
    async fn fetch_server(&self, id: &str) -> Result<Server> {
        let servers = self.servers.lock().await;
        servers
            .get(id)
            .cloned()
            .ok_or_else(|| create_error!(NotFound))
    }

    /// Fetch a servers by their ids
    async fn fetch_servers<'a>(&self, ids: &'a [String]) -> Result<Vec<Server>> {
        let servers = self.servers.lock().await;
        ids.iter()
            .map(|id| {
                servers
                    .get(id)
                    .cloned()
                    .ok_or_else(|| create_error!(NotFound))
            })
            .collect()
    }

    /// Update a server with new information
    async fn update_server(
        &self,
        id: &str,
        partial: &PartialServer,
        remove: Vec<FieldsServer>,
    ) -> Result<()> {
        let mut servers = self.servers.lock().await;
        if let Some(server) = servers.get_mut(id) {
            for field in remove {
                #[allow(clippy::disallowed_methods)]
                server.remove_field(&field);
            }

            server.apply_options(partial.clone());
            Ok(())
        } else {
            Err(create_error!(NotFound))
        }
    }

    /// Delete a server by its id
    async fn delete_server(&self, id: &str) -> Result<()> {
        let mut servers = self.servers.lock().await;
        if servers.remove(id).is_some() {
            Ok(())
        } else {
            Err(create_error!(NotFound))
        }
    }

    /// Insert a new role into server object
    async fn insert_role(&self, server_id: &str, role: &Role) -> Result<()> {
        let mut servers = self.servers.lock().await;
        if let Some(server) = servers.get_mut(server_id) {
            server.roles.insert(role.id.clone(), role.clone());
            Ok(())
        } else {
            Err(create_error!(NotFound))
        }
    }

    /// Update an existing role on a server
    async fn update_role(
        &self,
        server_id: &str,
        role_id: &str,
        partial: &PartialRole,
        remove: Vec<FieldsRole>,
    ) -> Result<()> {
        let mut servers = self.servers.lock().await;
        if let Some(server) = servers.get_mut(server_id) {
            if let Some(role) = server.roles.get_mut(role_id) {
                for field in remove {
                    #[allow(clippy::disallowed_methods)]
                    role.remove_field(&field);
                }

                role.apply_options(partial.clone());
                Ok(())
            } else {
                Err(create_error!(NotFound))
            }
        } else {
            Err(create_error!(NotFound))
        }
    }

    /// Delete a role from a server
    ///
    /// Also updates channels and members.
    async fn delete_role(&self, server_id: &str, role_id: &str) -> Result<()> {
        {
            let mut servers = self.servers.lock().await;
            if let Some(server) = servers.get_mut(server_id) {
                if server.roles.remove(role_id).is_none() {
                    return Err(create_error!(NotFound));
                }
            } else {
                return Err(create_error!(NotFound));
            }
        }

        let mut members = self.server_members.lock().await;
        for member in members.values_mut() {
            if member.id.server == server_id {
                member.roles.retain(|role| role != role_id);
            }
        }
        drop(members);

        let mut channels = self.channels.lock().await;
        for channel in channels.values_mut() {
            if let crate::Channel::TextChannel {
                server,
                role_permissions,
                ..
            } = channel
            {
                if server == server_id {
                    role_permissions.remove(role_id);
                }
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use syrnike_permissions::OverrideField;

    use crate::{Channel, Database, Member, MemberCompositeKey, ReferenceDb, Role, Server};

    #[async_std::test]
    async fn delete_role_cleans_reference_members_and_channel_permissions() {
        let db = Database::Reference(ReferenceDb::default());
        let role_id = "role-1".to_string();
        let kept_role_id = "role-2".to_string();
        let server = Server {
            id: "server-1".to_string(),
            owner: "owner-1".to_string(),
            name: "Server".to_string(),
            description: None,
            channels: vec!["channel-1".to_string()],
            categories: None,
            system_messages: None,
            roles: HashMap::from([
                (
                    role_id.clone(),
                    Role {
                        id: role_id.clone(),
                        name: "Deleted".to_string(),
                        permissions: OverrideField::default(),
                        colour: None,
                        hoist: false,
                        mentionable: true,
                        rank: 1,
                        icon: None,
                    },
                ),
                (
                    kept_role_id.clone(),
                    Role {
                        id: kept_role_id.clone(),
                        name: "Kept".to_string(),
                        permissions: OverrideField::default(),
                        colour: None,
                        hoist: false,
                        mentionable: true,
                        rank: 2,
                        icon: None,
                    },
                ),
            ]),
            default_permissions: 0,
            icon: None,
            banner: None,
            flags: None,
            nsfw: false,
            analytics: false,
            discoverable: false,
        };
        let channel = Channel::TextChannel {
            id: "channel-1".to_string(),
            server: server.id.clone(),
            name: "general".to_string(),
            description: None,
            icon: None,
            last_message_id: None,
            default_permissions: None,
            role_permissions: HashMap::from([
                (role_id.clone(), OverrideField { a: 1, d: 0 }),
                (kept_role_id.clone(), OverrideField { a: 2, d: 0 }),
            ]),
            nsfw: false,
            voice: None,
            slowmode: None,
        };
        let member = Member {
            id: MemberCompositeKey {
                server: server.id.clone(),
                user: "user-1".to_string(),
            },
            roles: vec![role_id.clone(), kept_role_id.clone()],
            ..Default::default()
        };

        db.insert_server(&server).await.unwrap();
        db.insert_channel(&channel).await.unwrap();
        db.insert_or_merge_member(&member).await.unwrap();

        db.delete_role(&server.id, &role_id).await.unwrap();

        let server = db.fetch_server(&server.id).await.unwrap();
        assert!(!server.roles.contains_key(&role_id));
        assert!(server.roles.contains_key(&kept_role_id));

        let member = db.fetch_member(&server.id, "user-1").await.unwrap();
        assert_eq!(member.roles, vec![kept_role_id.clone()]);

        let channel = db.fetch_channel("channel-1").await.unwrap();
        match channel {
            Channel::TextChannel {
                role_permissions, ..
            } => {
                assert!(!role_permissions.contains_key(&role_id));
                assert!(role_permissions.contains_key(&kept_role_id));
            }
            _ => unreachable!("expected text channel"),
        }
    }
}
