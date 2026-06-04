use std::time::Duration;

use log::warn;
use syrnike_database::Database;
use syrnike_result::Result;
use tokio::time::sleep;

pub async fn task(db: Database) -> Result<()> {
    loop {
        let success = db.remove_dangling_members().await;
        if let Err(s) = success {
            syrnike_config::capture_error(&s);
            warn!("Failed to prune dangling members: {:?}", &s);
        }

        sleep(Duration::from_secs(90)).await;
    }
}
