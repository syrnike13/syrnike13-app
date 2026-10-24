use bson::Document;
use syrnike_result::Result;

use crate::{
    ActivityApplication, FieldsActivityApplication, IntoDocumentPath, MongoDb,
    PartialActivityApplication,
};

use super::AbstractActivityApplications;

static COL: &str = "activity_applications";

#[async_trait]
impl AbstractActivityApplications for MongoDb {
    async fn insert_activity_application(&self, application: &ActivityApplication) -> Result<()> {
        query!(self, insert_one, COL, &application).map(|_| ())
    }

    async fn fetch_activity_application(&self, id: &str) -> Result<ActivityApplication> {
        query!(self, find_one_by_id, COL, id)?.ok_or_else(|| create_error!(NotFound))
    }

    async fn fetch_activity_applications(&self) -> Result<Vec<ActivityApplication>> {
        query!(self, find, COL, doc! {})
    }

    async fn update_activity_application(
        &self,
        id: &str,
        partial: &PartialActivityApplication,
        remove: &[FieldsActivityApplication],
    ) -> Result<()> {
        query!(
            self,
            update_one_by_id,
            COL,
            id,
            partial,
            remove
                .iter()
                .map(|field| field as &dyn IntoDocumentPath)
                .collect(),
            None
        )
        .map(|_| ())
    }

    async fn delete_activity_application(&self, id: &str) -> Result<()> {
        let result = self
            .col::<Document>(COL)
            .delete_one(doc! { "_id": id })
            .await
            .map_err(|_| create_database_error!("delete_one", COL))?;

        if result.deleted_count == 0 {
            return Err(create_error!(NotFound));
        }

        Ok(())
    }
}

impl IntoDocumentPath for FieldsActivityApplication {
    fn as_path(&self) -> Option<&'static str> {
        Some(match self {
            FieldsActivityApplication::Description => "description",
            FieldsActivityApplication::Icon => "icon",
            FieldsActivityApplication::ClientSecretHash => "client_secret_hash",
        })
    }
}
