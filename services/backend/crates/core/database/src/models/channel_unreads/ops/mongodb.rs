use bson::Document;
use mongodb::options::FindOneAndUpdateOptions;
use mongodb::options::ReturnDocument;
use mongodb::options::UpdateOptions;
use syrnike_result::Result;
use ulid::Ulid;

use crate::ChannelUnread;
use crate::MongoDb;

use super::AbstractChannelUnreads;

static COL: &str = "channel_unreads";

#[async_trait]
impl AbstractChannelUnreads for MongoDb {
    /// Acknowledge a message, and returns updated channel unread.
    async fn acknowledge_message(
        &self,
        channel_id: &str,
        user_id: &str,
        message_id: &str,
    ) -> Result<Option<ChannelUnread>> {
        self.col::<ChannelUnread>(COL)
            .find_one_and_update(
                doc! {
                    "_id.channel": channel_id,
                    "_id.user": user_id,
                },
                doc! {
                    "$pull": {
                        "mentions": {
                            "$lte": message_id
                        }
                    },
                    "$set": {
                        "last_id": message_id
                    }
                },
            )
            .with_options(
                FindOneAndUpdateOptions::builder()
                    .upsert(true)
                    .return_document(ReturnDocument::After)
                    .build(),
            )
            .await
            .map_err(|_| create_database_error!("update_one", COL))
    }

    /// Acknowledge many channels.
    async fn acknowledge_channels(&self, user_id: &str, channel_ids: &[String]) -> Result<()> {
        let current_time = Ulid::new().to_string();

        self.col::<Document>(COL)
            .delete_many(doc! {
                "_id.channel": {
                    "$in": channel_ids
                },
                "_id.user": user_id
            })
            .await
            .map_err(|_| create_database_error!("delete_many", COL))?;

        self.col::<Document>(COL)
            .insert_many(
                channel_ids
                    .iter()
                    .map(|channel_id| {
                        doc! {
                            "_id": {
                                "channel": channel_id,
                                "user": user_id
                            },
                            "last_id": &current_time
                        }
                    })
                    .collect::<Vec<Document>>(),
            )
            .await
            .map(|_| ())
            .map_err(|_| create_database_error!("update_many", COL))
    }

    /// Add a mention.
    async fn add_mention_to_unread<'a>(
        &self,
        channel_id: &str,
        user_id: &str,
        message_ids: &[String],
    ) -> Result<()> {
        self.col::<Document>(COL)
            .update_one(
                doc! {
                    "_id.channel": channel_id,
                    "_id.user": user_id,
                },
                doc! {
                    "$push": {
                        "mentions": {
                            "$each": message_ids
                        }
                    }
                },
            )
            .with_options(UpdateOptions::builder().upsert(true).build())
            .await
            .map(|_| ())
            .map_err(|_| create_database_error!("update_one", COL))
    }

    /// Add a mention to multiple users.
    async fn add_mention_to_many_unreads<'a>(
        &self,
        channel_id: &str,
        user_ids: &[String],
        message_ids: &[String],
    ) -> Result<()> {
        for user_id in user_ids {
            self.add_mention_to_unread(channel_id, user_id, message_ids)
                .await?;
        }

        Ok(())
    }

    /// Fetch all channel unreads for a user.
    async fn fetch_unreads(&self, user_id: &str) -> Result<Vec<ChannelUnread>> {
        query!(
            self,
            find,
            COL,
            doc! {
                "_id.user": user_id
            }
        )
    }

    async fn fetch_unread_mentions(&self, user_id: &str) -> Result<Vec<ChannelUnread>> {
        query! {
            self,
            find,
            COL,
            doc! {
                "_id.user": user_id,
                "mentions": {"$ne": null}
            }
        }
    }

    /// Fetch unread for a specific user in a channel.
    async fn fetch_unread(&self, user_id: &str, channel_id: &str) -> Result<Option<ChannelUnread>> {
        query!(
            self,
            find_one,
            COL,
            doc! {
                "_id.user": user_id,
                "_id.channel": channel_id
            }
        )
    }
}

#[cfg(test)]
mod tests {
    use crate::{Database, DatabaseInfo};

    #[async_std::test]
    async fn add_mention_to_many_unreads_creates_one_unread_per_new_user() {
        let db = DatabaseInfo::Test(
            "add_mention_to_many_unreads_creates_one_unread_per_new_user".to_string(),
        )
        .connect()
        .await
        .expect("database connection");

        if !matches!(db, Database::MongoDb(_)) {
            return;
        }

        db.drop_database().await;

        let channel_id = "channel-1".to_string();
        let message_id = "message-1".to_string();
        let users = vec!["user-1".to_string(), "user-2".to_string()];
        let messages = vec![message_id.clone()];

        db.add_mention_to_many_unreads(&channel_id, &users, &messages)
            .await
            .unwrap();

        for user_id in users {
            let unread = db
                .fetch_unread(&user_id, &channel_id)
                .await
                .unwrap()
                .expect("unread");
            assert_eq!(unread.mentions, Some(vec![message_id.clone()]));
        }

        db.drop_database().await;
    }
}
