use syrnike_result::Result;

use crate::{ActivityApplication, FieldsActivityApplication, PartialActivityApplication};

#[cfg(feature = "mongodb")]
mod mongodb;
mod reference;

#[async_trait]
pub trait AbstractActivityApplications: Sync + Send {
    /// Insert application; fails if the id is taken.
    async fn insert_activity_application(&self, application: &ActivityApplication) -> Result<()>;

    /// Fetch application by id (enabled or not).
    async fn fetch_activity_application(&self, id: &str) -> Result<ActivityApplication>;

    /// Fetch every registered application.
    async fn fetch_activity_applications(&self) -> Result<Vec<ActivityApplication>>;

    /// Update application by id.
    async fn update_activity_application(
        &self,
        id: &str,
        partial: &PartialActivityApplication,
        remove: &[FieldsActivityApplication],
    ) -> Result<()>;

    /// Delete application by id.
    async fn delete_activity_application(&self, id: &str) -> Result<()>;
}
