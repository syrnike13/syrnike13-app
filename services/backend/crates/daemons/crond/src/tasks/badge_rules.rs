use std::time::Duration;

use log::warn;
use syrnike_database::{reconcile_badge_rules, Database};
use syrnike_result::Result;
use tokio::time::sleep;

pub async fn task(db: Database) -> Result<()> {
    loop {
        if let Err(error) = reconcile_badge_rules(&db).await {
            syrnike_config::capture_error(&error);
            warn!("Failed to reconcile badge rules: {error:?}");
        }

        sleep(Duration::from_secs(60 * 60)).await;
    }
}
