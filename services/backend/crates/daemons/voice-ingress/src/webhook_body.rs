use syrnike_result::{create_error, Error};
use rocket::{
    data::{Data, FromData, Outcome, ToByteUnit},
    http::Status,
    request::Request,
};

const WEBHOOK_BODY_LIMIT_BYTES: u64 = 1024 * 1024;

pub struct WebhookBody(String);

impl WebhookBody {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[rocket::async_trait]
impl<'r> FromData<'r> for WebhookBody {
    type Error = Error;

    async fn from_data(req: &'r Request<'_>, data: Data<'r>) -> Outcome<'r, Self> {
        let body = match data
            .open(WEBHOOK_BODY_LIMIT_BYTES.bytes())
            .into_string()
            .await
        {
            Ok(body) => body,
            Err(error) => {
                log::error!("Failed to read LiveKit webhook body: {error}");
                return Outcome::Error((Status::BadRequest, create_error!(InternalError)));
            }
        };

        if !body.is_complete() {
            return Outcome::Error((Status::PayloadTooLarge, create_error!(PayloadTooLarge)));
        }

        let body = body.into_inner();
        if body.is_empty() {
            log::error!(
                "Received empty LiveKit webhook body, content_length={:?}",
                req.headers().get_one("Content-Length")
            );
        }

        Outcome::Success(Self(body))
    }
}

#[cfg(test)]
mod tests {
    use rocket::{
        http::{ContentType, Status},
        local::asynchronous::Client,
        post, routes,
    };

    use super::WebhookBody;

    #[post("/", data = "<body>")]
    async fn echo_len(body: WebhookBody) -> String {
        body.as_str().len().to_string()
    }

    #[rocket::async_test]
    async fn reads_large_livekit_webhook_payloads() {
        let payload = format!(
            r#"{{"event":"track_published","padding":"{}"}}"#,
            "x".repeat(64 * 1024)
        );
        let expected_len = payload.len().to_string();
        let client = Client::tracked(rocket::build().mount("/", routes![echo_len]))
            .await
            .expect("valid rocket client");

        let response = client
            .post("/")
            .header(ContentType::new("application", "webhook+json"))
            .body(payload.clone())
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::Ok);
        assert_eq!(
            response.into_string().await.as_deref(),
            Some(expected_len.as_str())
        );
    }
}
