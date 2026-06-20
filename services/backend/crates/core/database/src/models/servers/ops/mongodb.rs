use bson::{Bson, Document, to_document};
use futures::StreamExt;
use syrnike_result::Result;

use crate::{FieldsRole, FieldsServer, PartialRole, PartialServer, Role, Server};
use crate::{IntoDocumentPath, MongoDb};

use super::AbstractServers;

static COL: &str = "servers";

#[async_trait]
impl AbstractServers for MongoDb {
    /// Insert a new server into database
    async fn insert_server(&self, server: &Server) -> Result<()> {
        query!(self, insert_one, COL, &server).map(|_| ())
    }

    /// Fetch a server by its id
    async fn fetch_server(&self, id: &str) -> Result<Server> {
        query!(self, find_one_by_id, COL, id)?.ok_or_else(|| create_error!(NotFound))
    }

    /// Fetch a servers by their ids
    async fn fetch_servers<'a>(&self, ids: &'a [String]) -> Result<Vec<Server>> {
        Ok(self
            .col::<Server>(COL)
            .find(doc! {
                "_id": {
                    "$in": ids
                }
            })
            .await
            .map_err(|_| create_database_error!("find", "servers"))?
            .filter_map(|s| async {
                if cfg!(debug_assertions) {
                    Some(s.unwrap())
                } else {
                    s.ok()
                }
            })
            .collect()
            .await)
    }

    /// Update a server with new information
    async fn update_server(
        &self,
        id: &str,
        partial: &PartialServer,
        remove: Vec<FieldsServer>,
    ) -> Result<()> {
        query!(
            self,
            update_one_by_id,
            COL,
            id,
            partial,
            remove.iter().map(|x| x as &dyn IntoDocumentPath).collect(),
            None
        )
        .map(|_| ())
    }

    /// Delete a server by its id
    async fn delete_server(&self, id: &str) -> Result<()> {
        self.delete_associated_server_objects(id).await?;
        query!(self, delete_one_by_id, COL, id).map(|_| ())
    }

    /// Insert a new role into server object
    async fn insert_role(&self, server_id: &str, role: &Role) -> Result<()> {
        self.col::<Document>(COL)
            .update_one(
                doc! {
                    "_id": server_id
                },
                doc! {
                    "$set": {
                        "roles.".to_owned() + role.id.as_str(): to_document(role)
                            .map_err(|_| create_database_error!("to_document", "role"))?
                    }
                },
            )
            .await
            .map(|_| ())
            .map_err(|_| create_database_error!("update_one", "server"))
    }

    /// Update an existing role on a server
    async fn update_role(
        &self,
        server_id: &str,
        role_id: &str,
        partial: &PartialRole,
        remove: Vec<FieldsRole>,
    ) -> Result<()> {
        query!(
            self,
            update_one_by_id,
            COL,
            server_id,
            partial,
            remove.iter().map(|x| x as &dyn IntoDocumentPath).collect(),
            "roles.".to_owned() + role_id + "."
        )
        .map(|_| ())
    }

    /// Delete a role from a server
    ///
    /// Also updates channels and members.
    async fn delete_role(&self, server_id: &str, role_id: &str) -> Result<()> {
        self.col::<Document>("server_members")
            .update_many(
                doc! {
                    "_id.server": server_id
                },
                doc! {
                    "$pull": {
                        "roles": &role_id
                    }
                },
            )
            .await
            .map_err(|_| create_database_error!("update_many", "server_members"))?;

        self.col::<Document>("channels")
            .update_many(
                doc! {
                    "server": server_id
                },
                doc! {
                    "$unset": {
                        "role_permissions.".to_owned() + role_id: 1_i32
                    }
                },
            )
            .await
            .map_err(|_| create_database_error!("update_many", "channels"))?;

        self.col::<Document>("servers")
            .update_one(
                doc! {
                    "_id": server_id
                },
                doc! {
                    "$unset": {
                        "roles.".to_owned() + role_id: 1_i32
                    }
                },
            )
            .await
            .map(|_| ())
            .map_err(|_| create_database_error!("update_one", "servers"))
    }
}

impl IntoDocumentPath for FieldsServer {
    fn as_path(&self) -> Option<&'static str> {
        Some(match self {
            FieldsServer::Banner => "banner",
            FieldsServer::Categories => "categories",
            FieldsServer::Description => "description",
            FieldsServer::Icon => "icon",
            FieldsServer::SystemMessages => "system_messages",
        })
    }
}

impl IntoDocumentPath for FieldsRole {
    fn as_path(&self) -> Option<&'static str> {
        Some(match self {
            FieldsRole::Colour => "colour",
            FieldsRole::Icon => "icon",
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::{Channel, Database, DatabaseInfo, fixture};

    #[async_std::test]
    async fn delete_role_clears_permissions_from_all_server_channels() {
        let db = DatabaseInfo::Test(
            "delete_role_clears_permissions_from_all_server_channels".to_string(),
        )
        .connect()
        .await
        .expect("database connection");

        if !matches!(db, Database::MongoDb(_)) {
            return;
        }

        db.drop_database().await;

        fixture!(db, "server_with_roles",
            channel channel 3
            server server 4);

        let role_id = server
            .roles
            .iter()
            .find_map(|(id, role)| (role.name == "Moderator").then(|| id.clone()))
            .expect("moderator role");

        let permissions = match &channel {
            Channel::TextChannel {
                role_permissions, ..
            } => role_permissions
                .get(&role_id)
                .cloned()
                .expect("fixture channel role permissions"),
            _ => unreachable!("fixture channel should be text"),
        };

        let second_channel_id = ulid::Ulid::new().to_string();
        let second_channel = Channel::TextChannel {
            id: second_channel_id.clone(),
            server: server.id.clone(),
            name: "Second".to_string(),
            description: None,
            icon: None,
            last_message_id: None,
            default_permissions: None,
            role_permissions: Default::default(),
            nsfw: false,
            voice: None,
            slowmode: None,
        };

        db.insert_channel(&second_channel).await.unwrap();
        db.set_channel_role_permission(&second_channel_id, &role_id, permissions)
            .await
            .unwrap();

        db.delete_role(&server.id, &role_id).await.unwrap();

        let members_with_deleted_role = db
            .fetch_all_members_with_roles(&server.id, &[role_id.clone()])
            .await
            .unwrap();
        assert!(members_with_deleted_role.is_empty());

        for channel_id in [channel.id().to_string(), second_channel_id] {
            let channel = db.fetch_channel(&channel_id).await.unwrap();
            match channel {
                Channel::TextChannel {
                    role_permissions, ..
                } => assert!(!role_permissions.contains_key(&role_id)),
                _ => unreachable!("expected text channel"),
            }
        }

        db.drop_database().await;
    }
}

impl MongoDb {
    pub async fn delete_associated_server_objects(&self, server_id: &str) -> Result<()> {
        // Find all channels
        let channels: Vec<String> = self
            .col::<Document>("channels")
            .find(doc! {
                "server": server_id
            })
            .await
            .map_err(|_| create_database_error!("find", "channels"))?
            .filter_map(|s| async {
                s.map(|d| d.get_str("_id").map(|s| s.to_string()).ok())
                    .ok()
                    .flatten()
            })
            .collect()
            .await;

        // Check if there are any attachments we need to delete.
        self.delete_bulk_messages(doc! {
            "channel": {
                "$in": &channels
            }
        })
        .await?;

        // Delete all emoji.
        self.col::<Document>("emojis")
            .update_many(
                doc! {
                    "parent.id": &server_id
                },
                doc! {
                    "$set": {
                        "parent": {
                            "type": "Detached"
                        }
                    }
                },
            )
            .await
            .map_err(|_| create_database_error!("update_many", "emojis"))?;

        // Delete all channels.
        self.col::<Document>("channels")
            .delete_many(doc! {
                "server": &server_id
            })
            .await
            .map_err(|_| create_database_error!("delete_many", "channels"))?;

        // Delete any associated objects, e.g. unreads and invites.
        self.delete_associated_channel_objects(Bson::Document(doc! { "$in": &channels }))
            .await?;

        // Delete members and bans.
        for with in &["server_members", "server_bans"] {
            self.col::<Document>(with)
                .delete_many(doc! {
                    "_id.server": &server_id
                })
                .await
                .map_err(|_| create_database_error!("delete_many", with))?;
        }

        // Update many attachments with parent id.
        self.delete_many_attachments(doc! {
            "used_for.id": &server_id
        })
        .await?;

        Ok(())
    }
}
