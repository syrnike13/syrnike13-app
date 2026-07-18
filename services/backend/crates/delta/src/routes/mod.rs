use revolt_rocket_okapi::{revolt_okapi::openapi3::OpenApi, settings::OpenApiSettings};
pub use rocket::http::Status;
pub use rocket::response::Redirect;
use rocket::{Build, Rocket};
use syrnike_config::Settings;

mod admin;
mod auth_account;
mod bots;
mod channels;
mod customisation;
mod diagnostics;
mod invites;
mod onboard;
mod policy;
mod push;
mod root;
mod safety;
mod servers;
mod sync;
pub(crate) mod telemetry;
mod users;
mod voice_call_member_sync;
mod webhooks;

pub fn mount(config: Settings, mut rocket: Rocket<Build>) -> Rocket<Build> {
    let settings = OpenApiSettings::default();

    if config.features.webhooks_enabled {
        mount_endpoints_and_merged_docs! {
            rocket, "/".to_owned(), settings,
            "/" => (vec![], custom_openapi_spec()),
            "" => openapi_get_routes_spec![root::root],
            "/admin" => admin::routes(),
            "/users" => users::routes(),
            "/bots" => bots::routes(),
            "/channels" => channels::routes(),
            "/servers" => servers::routes(),
            "/invites" => invites::routes(),
            "/custom" => customisation::routes(),
            "/diagnostics" => diagnostics::routes(),
            "/safety" => safety::routes(),
            "/auth/account" => auth_account::routes(),
            "/auth/session" => rocket_authifier::routes::session::routes(),
            "/auth/mfa" => rocket_authifier::routes::mfa::routes(),
            "/onboard" => onboard::routes(),
            "/policy" => policy::routes(),
            "/push" => push::routes(),
            "/sync" => sync::routes(),
            "/telemetry" => telemetry::routes(),
            "/webhooks" => webhooks::routes()
        };
    } else {
        mount_endpoints_and_merged_docs! {
            rocket, "/".to_owned(), settings,
            "/" => (vec![], custom_openapi_spec()),
            "" => openapi_get_routes_spec![root::root],
            "/admin" => admin::routes(),
            "/users" => users::routes(),
            "/bots" => bots::routes(),
            "/channels" => channels::routes(),
            "/servers" => servers::routes(),
            "/invites" => invites::routes(),
            "/custom" => customisation::routes(),
            "/diagnostics" => diagnostics::routes(),
            "/safety" => safety::routes(),
            "/auth/account" => auth_account::routes(),
            "/auth/session" => rocket_authifier::routes::session::routes(),
            "/auth/mfa" => rocket_authifier::routes::mfa::routes(),
            "/onboard" => onboard::routes(),
            "/policy" => policy::routes(),
            "/push" => push::routes(),
            "/sync" => sync::routes(),
            "/telemetry" => telemetry::routes()
        };
    }

    if config.features.webhooks_enabled {
        mount_endpoints_and_merged_docs! {
            rocket, "/0.8".to_owned(), settings,
            "/" => (vec![], custom_openapi_spec()),
            "" => openapi_get_routes_spec![root::root],
            "/admin" => admin::routes(),
            "/users" => users::routes(),
            "/bots" => bots::routes(),
            "/channels" => channels::routes(),
            "/servers" => servers::routes(),
            "/invites" => invites::routes(),
            "/custom" => customisation::routes(),
            "/safety" => safety::routes(),
            "/auth/account" => auth_account::routes(),
            "/auth/session" => rocket_authifier::routes::session::routes(),
            "/auth/mfa" => rocket_authifier::routes::mfa::routes(),
            "/onboard" => onboard::routes(),
            "/push" => push::routes(),
            "/sync" => sync::routes(),
            "/webhooks" => webhooks::routes()
        };
    } else {
        mount_endpoints_and_merged_docs! {
            rocket, "/0.8".to_owned(), settings,
            "/" => (vec![], custom_openapi_spec()),
            "" => openapi_get_routes_spec![root::root],
            "/admin" => admin::routes(),
            "/users" => users::routes(),
            "/bots" => bots::routes(),
            "/channels" => channels::routes(),
            "/servers" => servers::routes(),
            "/invites" => invites::routes(),
            "/custom" => customisation::routes(),
            "/safety" => safety::routes(),
            "/auth/account" => auth_account::routes(),
            "/auth/session" => rocket_authifier::routes::session::routes(),
            "/auth/mfa" => rocket_authifier::routes::mfa::routes(),
            "/onboard" => onboard::routes(),
            "/push" => push::routes(),
            "/sync" => sync::routes()
        };
    }

    rocket
}

fn custom_openapi_spec() -> OpenApi {
    use revolt_okapi::openapi3::*;

    let mut extensions = schemars::Map::new();
    extensions.insert(
        "x-logo".to_owned(),
        json!({
            "url": "https://syrnike13.ru/header.png",
            "altText": "syrnike13"
        }),
    );

    extensions.insert(
        "x-tagGroups".to_owned(),
        json!([
          {
            "name": "syrnike13",
            "tags": [
              "Core"
            ]
          },
          {
            "name": "Users",
            "tags": [
              "User Information",
              "Direct Messaging",
              "Relationships"
            ]
          },
          {
            "name": "Bots",
            "tags": [
              "Bots"
            ]
          },
          {
            "name": "Channels",
            "tags": [
              "Channel Information",
              "Channel Invites",
              "Channel Permissions",
              "Messaging",
              "Interactions",
              "Groups",
              "Voice",
              "Webhooks",
            ]
          },
          {
            "name": "Servers",
            "tags": [
              "Server Information",
              "Server Members",
              "Server Permissions",
              "Server Audit Log"
            ]
          },
          {
            "name": "Invites",
            "tags": [
              "Invites"
            ]
          },
          {
            "name": "Customisation",
            "tags": [
              "Emojis"
            ]
          },
          {
            "name": "Platform Administration",
            "tags": [
              "Admin",
              "User Safety"
            ]
          },
          {
            "name": "Authentication",
            "tags": [
              "Account",
              "Session",
              "Onboarding",
              "MFA"
            ]
          },
          {
            "name": "Miscellaneous",
            "tags": [
              "Sync",
              "Web Push"
            ]
          }
        ]),
    );

    OpenApi {
        openapi: OpenApi::default_version(),
        info: Info {
            title: "syrnike13 API".to_owned(),
            description: Some("Open source user-first chat platform.".to_owned()),
            terms_of_service: Some("https://syrnike13.ru/terms".to_owned()),
            contact: Some(Contact {
                name: Some("syrnike13 Support".to_owned()),
                url: Some("https://syrnike13.ru".to_owned()),
                email: Some("contact@syrnike13.ru".to_owned()),
                ..Default::default()
            }),
            license: Some(License {
                name: "AGPLv3".to_owned(),
                url: Some("https://github.com/syrnike13/syrnike13-app".to_owned()),
                ..Default::default()
            }),
            version: env!("CARGO_PKG_VERSION").to_string(),
            ..Default::default()
        },
        servers: vec![
            Server {
                url: "https://syrnike13.ru/api".to_owned(),
                description: Some("syrnike13 Production".to_owned()),
                ..Default::default()
            },
            Server {
                url: "https://syrnike13.ru/api".to_owned(),
                description: Some("syrnike13 Production API".to_owned()),
                ..Default::default()
            },
            Server {
                url: "http://127.0.0.1:14702".to_owned(),
                description: Some("Local syrnike13 Environment".to_owned()),
                ..Default::default()
            },
            Server {
                url: "http://127.0.0.1:14702/0.8".to_owned(),
                description: Some("Local syrnike13 Environment (v0.8)".to_owned()),
                ..Default::default()
            },
        ],
        external_docs: Some(ExternalDocs {
            url: "https://syrnike13.ru".to_owned(),
            description: Some("syrnike13 Developer Documentation".to_owned()),
            ..Default::default()
        }),
        extensions,
        tags: vec![
            Tag {
                name: "Core".to_owned(),
                description: Some(
                    "Use in your applications to determine information about the syrnike13 node"
                        .to_owned(),
                ),
                ..Default::default()
            },
            Tag {
                name: "User Information".to_owned(),
                description: Some("Query and fetch users on syrnike13".to_owned()),
                ..Default::default()
            },
            Tag {
                name: "Direct Messaging".to_owned(),
                description: Some("Direct message other users on syrnike13".to_owned()),
                ..Default::default()
            },
            Tag {
                name: "Relationships".to_owned(),
                description: Some(
                    "Manage your friendships and block list on the platform".to_owned(),
                ),
                ..Default::default()
            },
            Tag {
                name: "Bots".to_owned(),
                description: Some("Create and edit bots".to_owned()),
                ..Default::default()
            },
            Tag {
                name: "Channel Information".to_owned(),
                description: Some("Query and fetch channels on syrnike13".to_owned()),
                ..Default::default()
            },
            Tag {
                name: "Channel Invites".to_owned(),
                description: Some("Create and manage invites for channels".to_owned()),
                ..Default::default()
            },
            Tag {
                name: "Channel Permissions".to_owned(),
                description: Some("Manage permissions for channels".to_owned()),
                ..Default::default()
            },
            Tag {
                name: "Messaging".to_owned(),
                description: Some("Send and manipulate messages".to_owned()),
                ..Default::default()
            },
            Tag {
                name: "Groups".to_owned(),
                description: Some("Create, invite users and manipulate groups".to_owned()),
                ..Default::default()
            },
            Tag {
                name: "Voice".to_owned(),
                description: Some("Join and talk with other users".to_owned()),
                ..Default::default()
            },
            Tag {
                name: "Server Information".to_owned(),
                description: Some("Query and fetch servers on syrnike13".to_owned()),
                ..Default::default()
            },
            Tag {
                name: "Server Members".to_owned(),
                description: Some("Find and edit server members".to_owned()),
                ..Default::default()
            },
            Tag {
                name: "Server Permissions".to_owned(),
                description: Some("Manage permissions for servers".to_owned()),
                ..Default::default()
            },
            Tag {
                name: "Server Audit Log".to_owned(),
                description: Some(
                    "Inspect server moderation and administration audit events".to_owned(),
                ),
                ..Default::default()
            },
            Tag {
                name: "Invites".to_owned(),
                description: Some("View, join and delete invites".to_owned()),
                ..Default::default()
            },
            Tag {
                name: "Account".to_owned(),
                description: Some("Manage your account".to_owned()),
                ..Default::default()
            },
            Tag {
                name: "Session".to_owned(),
                description: Some("Create and manage sessions".to_owned()),
                ..Default::default()
            },
            Tag {
                name: "MFA".to_owned(),
                description: Some("Multi-factor Authentication".to_owned()),
                ..Default::default()
            },
            Tag {
                name: "Onboarding".to_owned(),
                description: Some(
                    "After signing up to syrnike13, users must pick a unique username".to_owned(),
                ),
                ..Default::default()
            },
            Tag {
                name: "Sync".to_owned(),
                description: Some("Upload and retrieve any JSON data between clients".to_owned()),
                ..Default::default()
            },
            Tag {
                name: "Web Push".to_owned(),
                description: Some(
                    "Subscribe to and receive syrnike13 push notifications while offline"
                        .to_owned(),
                ),
                ..Default::default()
            },
            Tag {
                name: "Webhooks".to_owned(),
                description: Some("Send messages from 3rd party services".to_owned()),
                ..Default::default()
            },
        ],
        ..Default::default()
    }
}
