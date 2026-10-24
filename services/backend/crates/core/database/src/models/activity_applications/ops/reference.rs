use syrnike_result::Result;

use crate::{
    ActivityApplication, FieldsActivityApplication, PartialActivityApplication, ReferenceDb,
};

use super::AbstractActivityApplications;

#[async_trait]
impl AbstractActivityApplications for ReferenceDb {
    async fn insert_activity_application(&self, application: &ActivityApplication) -> Result<()> {
        let mut applications = self.activity_applications.lock().await;
        if applications.contains_key(&application.id) {
            return Err(create_database_error!("insert", "activity_application"));
        }
        applications.insert(application.id.clone(), application.clone());
        Ok(())
    }

    async fn fetch_activity_application(&self, id: &str) -> Result<ActivityApplication> {
        self.activity_applications
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| create_error!(NotFound))
    }

    async fn fetch_activity_applications(&self) -> Result<Vec<ActivityApplication>> {
        Ok(self
            .activity_applications
            .lock()
            .await
            .values()
            .cloned()
            .collect())
    }

    async fn update_activity_application(
        &self,
        id: &str,
        partial: &PartialActivityApplication,
        remove: &[FieldsActivityApplication],
    ) -> Result<()> {
        let mut applications = self.activity_applications.lock().await;
        let application = applications
            .get_mut(id)
            .ok_or_else(|| create_error!(NotFound))?;
        for field in remove {
            application.remove_field(field);
        }
        application.apply_options(partial.clone());
        Ok(())
    }

    async fn delete_activity_application(&self, id: &str) -> Result<()> {
        self.activity_applications
            .lock()
            .await
            .remove(id)
            .map(|_| ())
            .ok_or_else(|| create_error!(NotFound))
    }
}
