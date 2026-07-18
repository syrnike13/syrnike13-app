use std::time::{Duration, SystemTime, UNIX_EPOCH};

use log::{info, warn};
use syrnike_database::Database;
use syrnike_files::delete_from_s3;
use syrnike_result::Result;
use tokio::time::sleep;

pub async fn task(db: Database) -> Result<()> {
    loop {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        for report in db.fetch_expired_diagnostic_reports(now).await? {
            match delete_from_s3(&report.bucket_id, &report.object_key).await {
                Ok(()) => {
                    db.delete_diagnostic_report(&report.id).await?;
                    info!("Deleted expired diagnostic report {}", report.id);
                }
                Err(error) => {
                    warn!(
                        "Failed to delete diagnostic report {} from storage: {error:?}",
                        report.id
                    );
                }
            }
        }
        sleep(Duration::from_secs(60 * 60)).await;
    }
}
