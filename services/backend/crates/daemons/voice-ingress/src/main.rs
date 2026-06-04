use std::env;

use syrnike_database::DatabaseInfo;
use syrnike_database::{voice::VoiceClient, AMQP};
use syrnike_result::Result;
use rocket::{build, routes, Config};
use std::net::Ipv4Addr;

mod api;
mod guard;
mod webhook_body;

#[rocket::main]
async fn main() -> Result<(), rocket::Error> {
    syrnike_config::configure!(voice_ingress);

    let amqp = AMQP::new_auto().await;

    let database = DatabaseInfo::Auto.connect().await.unwrap();
    let voice_client = VoiceClient::from_syrnike_config().await;

    let _rocket = build()
        .manage(database)
        .manage(voice_client)
        .manage(amqp)
        .mount("/", routes![api::ingress])
        .configure(Config {
            port: 8500,
            address: Ipv4Addr::new(0, 0, 0, 0).into(),
            ..Default::default()
        })
        .ignite()
        .await?
        .launch()
        .await?;

    Ok(())
}
