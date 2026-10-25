use rocket::serde::json::Json;
use rocket::State;
use syrnike_database::{Database, User};
use syrnike_models::v0;
use syrnike_result::{create_error, ErrorType, Result};

use super::require_privileged;

#[openapi(tag = "Admin")]
#[get("/users/<query>")]
pub async fn fetch(db: &State<Database>, user: User, query: String) -> Result<Json<v0::User>> {
    require_privileged(&user)?;

    let target = lookup_user(db, &query).await?;
    Ok(Json(target.into_self_with_badges(db, false).await))
}

/// Resolve the id or tag an administrator pasted into the lookup field.
///
/// The client renders tags as `@username` and older clients still render
/// `username#0001`, so every form has to resolve to the same account.
async fn lookup_user(db: &Database, query: &str) -> Result<User> {
    match parse_lookup(query) {
        None => Err(create_error!(NotFound)),
        Some(UserLookup::Username(username)) => db.fetch_user_by_username(username).await,
        Some(UserLookup::IdOrUsername(candidate)) => match db.fetch_user(candidate).await {
            Ok(target) => Ok(target),
            Err(error) if matches!(error.error_type, ErrorType::NotFound) => {
                db.fetch_user_by_username(candidate).await
            }
            Err(error) => Err(error),
        },
    }
}

#[derive(Debug, PartialEq, Eq)]
enum UserLookup<'a> {
    /// Bare value: look it up by id, then fall back to a username.
    IdOrUsername(&'a str),
    /// Legacy `username#0001` tag: the discriminator is no longer part of the query.
    Username(&'a str),
}

fn parse_lookup(query: &str) -> Option<UserLookup<'_>> {
    let query = query.trim();
    // Tags are shown with a leading @ and pasted back together with it.
    let query = query.strip_prefix('@').unwrap_or(query).trim();

    if let Some((username, _discriminator)) = query.split_once('#') {
        let username = username.trim();
        return (!username.is_empty()).then_some(UserLookup::Username(username));
    }

    (!query.is_empty()).then_some(UserLookup::IdOrUsername(query))
}

#[cfg(test)]
mod tests {
    use syrnike_database::{Database, User};
    use syrnike_result::ErrorType;

    use super::{lookup_user, parse_lookup, UserLookup};

    #[test]
    fn accepts_bare_id_and_username() {
        assert_eq!(
            parse_lookup("01H8Y5Z6Q4XJ9V0QW3T7R2M8KD"),
            Some(UserLookup::IdOrUsername("01H8Y5Z6Q4XJ9V0QW3T7R2M8KD"))
        );
        assert_eq!(
            parse_lookup("  keklo  "),
            Some(UserLookup::IdOrUsername("keklo"))
        );
    }

    #[test]
    fn accepts_tags_with_a_leading_at() {
        assert_eq!(
            parse_lookup("@keklo"),
            Some(UserLookup::IdOrUsername("keklo"))
        );
        assert_eq!(
            parse_lookup("  @ keklo#0001  "),
            Some(UserLookup::Username("keklo"))
        );
    }

    #[test]
    fn accepts_legacy_discriminator_tags() {
        assert_eq!(
            parse_lookup("keklo#0001"),
            Some(UserLookup::Username("keklo"))
        );
    }

    #[test]
    fn rejects_empty_lookups() {
        for query in ["", "   ", "@", "@ ", "#0001", "@#0001", " #0001 "] {
            assert_eq!(parse_lookup(query), None, "query {query:?}");
        }
    }

    #[async_std::test]
    async fn resolves_ids_usernames_and_pasted_tags() {
        let db = Database::Reference(Default::default());
        let user = User {
            id: "01H8Y5Z6Q4XJ9V0QW3T7R2M8KD".into(),
            username: "Keklo".into(),
            ..Default::default()
        };

        db.insert_user(&user).await.expect("user inserted");

        for query in [
            "01H8Y5Z6Q4XJ9V0QW3T7R2M8KD",
            "keklo",
            "  @KEKLO  ",
            "keklo#0001",
            "@Keklo#0001",
        ] {
            let found = lookup_user(&db, query).await.expect("user found");
            assert_eq!(found.id, user.id, "lookup {query:?}");
        }

        let missing = lookup_user(&db, "missing").await;
        assert!(
            matches!(missing, Err(error) if matches!(error.error_type, ErrorType::NotFound)),
            "a missing user must not resolve"
        );
    }
}
