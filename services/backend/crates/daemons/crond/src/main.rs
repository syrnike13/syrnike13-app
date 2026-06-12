use syrnike_config::configure;
use syrnike_database::{voice::VoiceClient, DatabaseInfo, AMQP};
use syrnike_result::Result;
use tasks::{acks, file_deletion, prune_dangling_files, prune_members, voice_calls};
use tokio::try_join;

pub mod tasks;

#[tokio::main]
async fn main() -> Result<()> {
    configure!(crond);

    let db = DatabaseInfo::Auto.connect().await.expect("database");
    let amqp = AMQP::new_auto().await;
    let voice_client = VoiceClient::from_syrnike_config().await;

    try_join!(
        file_deletion::task(db.clone()),
        prune_dangling_files::task(db.clone()),
        prune_members::task(db.clone()),
        acks::task(db.clone(), amqp.clone()),
        voice_calls::task(db.clone(), voice_client, amqp.clone()),
    )
    .map(|_| ())
}
