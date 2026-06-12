use rocket::{
    http::Status,
    request::{FromRequest, Outcome},
    Request,
};
use syrnike_result::{create_error, Error};

pub struct AuthHeader<'a>(&'a str);

fn auth_token_from_header(header: &str) -> &str {
    header.strip_prefix("Bearer ").unwrap_or(header)
}

#[rocket::async_trait]
impl<'r> FromRequest<'r> for AuthHeader<'r> {
    type Error = Error;

    async fn from_request(request: &'r Request<'_>) -> Outcome<Self, Self::Error> {
        match request.headers().get("Authorization").next() {
            Some(token) => Outcome::Success(Self(token)),
            None => Outcome::Error((Status::Unauthorized, create_error!(NotAuthenticated))),
        }
    }
}

impl std::ops::Deref for AuthHeader<'_> {
    type Target = str;

    fn deref(&self) -> &Self::Target {
        auth_token_from_header(self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::AuthHeader;

    #[test]
    fn auth_header_exposes_bearer_token_without_scheme() {
        let header = AuthHeader("Bearer livekit.jwt.token");

        assert_eq!(&*header, "livekit.jwt.token");
    }

    #[test]
    fn auth_header_keeps_token_without_scheme() {
        let header = AuthHeader("livekit.jwt.token");

        assert_eq!(&*header, "livekit.jwt.token");
    }
}
