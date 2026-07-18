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
        let reports = match db.fetch_expired_diagnostic_reports(now).await {
            Ok(reports) => reports,
            Err(error) => {
                warn!("Failed to fetch expired diagnostic reports: {error:?}");
                sleep(Duration::from_secs(60 * 60)).await;
                continue;
            }
        };
        for report in reports {
            match delete_from_s3(&report.bucket_id, &report.object_key).await {
                Ok(()) => match db.delete_diagnostic_report(&report.id).await {
                    Ok(()) => info!("Deleted expired diagnostic report {}", report.id),
                    Err(error) => warn!(
                        "Deleted diagnostic object {}, but failed to delete its record: {error:?}",
                        report.id
                    ),
                },
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
