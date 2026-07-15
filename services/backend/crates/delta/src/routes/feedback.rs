use rocket::{serde::json::Json, State};
use syrnike_database::{
    Database, FeedbackSuggestion, FeedbackSuggestionPage, FeedbackSuggestionQuery,
    FeedbackSuggestionView, User,
};
use syrnike_models::v0;
use syrnike_result::{create_error, Result};
use validator::Validate;

const MAX_QUERY_SEARCH_LENGTH: usize = 200;

pub fn routes() -> (Vec<rocket::Route>, revolt_okapi::openapi3::OpenApi) {
    openapi_get_routes_spec![
        list,
        mine,
        detail,
        create,
        add_vote,
        remove_vote,
        admin_pending,
        approve,
        reject,
        merge,
        hide,
        set_status,
        set_response,
    ]
}

/// # List Feedback Suggestions
///
/// List approved product feedback suggestions. This catalogue is only available
/// to authenticated users.
#[openapi(tag = "Product Feedback")]
#[get("/?<search>&<category>&<area>&<platform>&<status>&<sort>&<offset>&<limit>")]
pub async fn list(
    db: &State<Database>,
    user: User,
    search: Option<String>,
    category: Option<String>,
    area: Option<String>,
    platform: Option<String>,
    status: Option<String>,
    sort: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<Json<v0::FeedbackSuggestionPage>> {
    let query = FeedbackSuggestionQuery {
        moderation_statuses: vec![v0::FeedbackModerationStatus::Approved],
        search: normalise_search(search)?,
        category: parse_category(category)?,
        area: parse_area(area)?,
        platform: parse_platform(platform)?,
        product_status: parse_product_status(status)?,
        sort: parse_sort(sort)?,
        offset: offset.unwrap_or_default(),
        limit: limit.unwrap_or(20),
        ..Default::default()
    };

    Ok(Json(page_into_api(
        db.fetch_feedback_suggestions(&user.id, query).await?,
        &user,
    )))
}

/// # List My Feedback Suggestions
///
/// List every feedback suggestion created by the current user, including ideas
/// that are pending, rejected, merged, or hidden from the public catalogue.
#[openapi(tag = "Product Feedback")]
#[get("/mine?<offset>&<limit>")]
pub async fn mine(
    db: &State<Database>,
    user: User,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<Json<v0::FeedbackSuggestionPage>> {
    let query = FeedbackSuggestionQuery {
        author_id: Some(user.id.clone()),
        sort: v0::FeedbackSort::New,
        offset: offset.unwrap_or_default(),
        limit: limit.unwrap_or(20),
        ..Default::default()
    };

    Ok(Json(page_into_api(
        db.fetch_feedback_suggestions(&user.id, query).await?,
        &user,
    )))
}

/// # Fetch Feedback Suggestion
///
/// Fetch one feedback suggestion when it is public, belongs to the caller, or
/// the caller is a platform administrator.
#[openapi(tag = "Product Feedback")]
#[get("/<id>")]
pub async fn detail(
    db: &State<Database>,
    user: User,
    id: String,
) -> Result<Json<v0::FeedbackSuggestion>> {
    let suggestion = db.fetch_feedback_suggestion(&id).await?;
    ensure_visible(&suggestion, &user)?;
    Ok(Json(view_into_api(
        db.fetch_feedback_suggestion_view(&id, &user.id).await?,
        &user,
    )))
}

/// # Create Feedback Suggestion
///
/// Create a feedback suggestion. New suggestions are pending and visible only to
/// their author and platform administrators until approved.
#[openapi(tag = "Product Feedback")]
#[post("/", data = "<data>")]
pub async fn create(
    db: &State<Database>,
    user: User,
    data: Json<v0::DataCreateFeedbackSuggestion>,
) -> Result<Json<v0::FeedbackSuggestion>> {
    if user.bot.is_some() {
        return Err(create_error!(IsBot));
    }

    let data = normalise_create_data(data.into_inner())?;
    let suggestion = FeedbackSuggestion::new(
        user.id.clone(),
        user.username.clone(),
        data.title,
        data.description,
        data.category,
        data.area,
        data.platform,
        data.anonymous,
    );
    db.insert_feedback_suggestion(&suggestion).await?;

    Ok(Json(view_into_api(
        db.fetch_feedback_suggestion_view(&suggestion.id, &user.id)
            .await?,
        &user,
    )))
}

/// # Add Feedback Vote
///
/// Idempotently add the current user's vote to an approved suggestion.
#[openapi(tag = "Product Feedback")]
#[put("/<id>/vote")]
pub async fn add_vote(
    db: &State<Database>,
    user: User,
    id: String,
) -> Result<Json<v0::FeedbackSuggestion>> {
    if user.bot.is_some() {
        return Err(create_error!(IsBot));
    }

    db.add_feedback_vote(&id, &user.id).await?;
    Ok(Json(view_into_api(
        db.fetch_feedback_suggestion_view(&id, &user.id).await?,
        &user,
    )))
}

/// # Remove Feedback Vote
///
/// Idempotently remove the current user's vote.
#[openapi(tag = "Product Feedback")]
#[delete("/<id>/vote")]
pub async fn remove_vote(
    db: &State<Database>,
    user: User,
    id: String,
) -> Result<Json<v0::FeedbackSuggestion>> {
    db.remove_feedback_vote(&id, &user.id).await?;
    let suggestion = db.fetch_feedback_suggestion(&id).await?;
    ensure_visible(&suggestion, &user)?;
    Ok(Json(view_into_api(
        db.fetch_feedback_suggestion_view(&id, &user.id).await?,
        &user,
    )))
}

/// # List Pending Feedback Suggestions
///
/// List suggestions awaiting platform moderation.
#[openapi(tag = "Product Feedback Administration")]
#[get("/admin/pending?<offset>&<limit>")]
pub async fn admin_pending(
    db: &State<Database>,
    user: User,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<Json<v0::FeedbackSuggestionPage>> {
    require_privileged(&user)?;
    let query = FeedbackSuggestionQuery {
        moderation_statuses: vec![v0::FeedbackModerationStatus::Pending],
        sort: v0::FeedbackSort::New,
        offset: offset.unwrap_or_default(),
        limit: limit.unwrap_or(20),
        ..Default::default()
    };

    Ok(Json(page_into_api(
        db.fetch_feedback_suggestions(&user.id, query).await?,
        &user,
    )))
}

/// # Approve Feedback Suggestion
///
/// Approve a pending feedback suggestion and safely add its submitter's vote.
#[openapi(tag = "Product Feedback Administration")]
#[post("/admin/<id>/approve")]
pub async fn approve(
    db: &State<Database>,
    user: User,
    id: String,
) -> Result<Json<v0::FeedbackSuggestion>> {
    require_privileged(&user)?;
    db.approve_feedback_suggestion(&id).await?;
    Ok(Json(view_into_api(
        db.fetch_feedback_suggestion_view(&id, &user.id).await?,
        &user,
    )))
}

/// # Reject Feedback Suggestion
///
/// Reject a pending feedback suggestion with an author-visible reason.
#[openapi(tag = "Product Feedback Administration")]
#[post("/admin/<id>/reject", data = "<data>")]
pub async fn reject(
    db: &State<Database>,
    user: User,
    id: String,
    data: Json<v0::DataRejectFeedbackSuggestion>,
) -> Result<Json<v0::FeedbackSuggestion>> {
    require_privileged(&user)?;
    let reason = normalise_required(data.into_inner().reason, "rejection reason")?;
    if !(3..=1000).contains(&reason.len()) {
        return validation_error("rejection reason must be between 3 and 1000 characters");
    }
    db.reject_feedback_suggestion(&id, reason).await?;
    Ok(Json(view_into_api(
        db.fetch_feedback_suggestion_view(&id, &user.id).await?,
        &user,
    )))
}

/// # Merge Feedback Suggestion
///
/// Merge a duplicate into an approved canonical suggestion while preserving
/// votes and removing duplicate voters.
#[openapi(tag = "Product Feedback Administration")]
#[post("/admin/<id>/merge", data = "<data>")]
pub async fn merge(
    db: &State<Database>,
    user: User,
    id: String,
    data: Json<v0::DataMergeFeedbackSuggestion>,
) -> Result<Json<v0::FeedbackSuggestion>> {
    require_privileged(&user)?;
    let mut data = data.into_inner();
    data.target_id = normalise_required(data.target_id, "target id")?;
    data.reason = normalise_optional(data.reason)?;
    data.validate().map_err(validation_from)?;
    db.merge_feedback_suggestion(&id, &data.target_id, data.reason)
        .await?;
    Ok(Json(view_into_api(
        db.fetch_feedback_suggestion_view(&id, &user.id).await?,
        &user,
    )))
}

/// # Hide Feedback Suggestion
///
/// Remove a feedback suggestion from all non-administrator views.
#[openapi(tag = "Product Feedback Administration")]
#[post("/admin/<id>/hide")]
pub async fn hide(
    db: &State<Database>,
    user: User,
    id: String,
) -> Result<Json<v0::FeedbackSuggestion>> {
    require_privileged(&user)?;
    db.hide_feedback_suggestion(&id).await?;
    Ok(Json(view_into_api(
        db.fetch_feedback_suggestion_view(&id, &user.id).await?,
        &user,
    )))
}

/// # Set Feedback Product Status
///
/// Update the public delivery status of an approved suggestion.
#[openapi(tag = "Product Feedback Administration")]
#[patch("/admin/<id>/status", data = "<data>")]
pub async fn set_status(
    db: &State<Database>,
    user: User,
    id: String,
    data: Json<v0::DataSetFeedbackProductStatus>,
) -> Result<Json<v0::FeedbackSuggestion>> {
    require_privileged(&user)?;
    db.set_feedback_product_status(&id, data.into_inner().status)
        .await?;
    Ok(Json(view_into_api(
        db.fetch_feedback_suggestion_view(&id, &user.id).await?,
        &user,
    )))
}

/// # Set Feedback Team Response
///
/// Add, replace, or clear the optional official response on a suggestion.
#[openapi(tag = "Product Feedback Administration")]
#[patch("/admin/<id>/response", data = "<data>")]
pub async fn set_response(
    db: &State<Database>,
    user: User,
    id: String,
    data: Json<v0::DataSetFeedbackTeamResponse>,
) -> Result<Json<v0::FeedbackSuggestion>> {
    require_privileged(&user)?;
    let mut data = data.into_inner();
    data.response = normalise_optional(data.response)?;
    data.validate().map_err(validation_from)?;
    db.set_feedback_team_response(&id, data.response).await?;
    Ok(Json(view_into_api(
        db.fetch_feedback_suggestion_view(&id, &user.id).await?,
        &user,
    )))
}

fn require_privileged(user: &User) -> Result<()> {
    if user.privileged {
        Ok(())
    } else {
        Err(create_error!(NotPrivileged))
    }
}

fn ensure_visible(suggestion: &FeedbackSuggestion, user: &User) -> Result<()> {
    if suggestion.is_visible_to(&user.id, user.privileged) {
        Ok(())
    } else {
        // Return a non-enumerating not-found response for inaccessible records.
        Err(create_error!(NotFound))
    }
}

fn page_into_api(page: FeedbackSuggestionPage, user: &User) -> v0::FeedbackSuggestionPage {
    v0::FeedbackSuggestionPage {
        suggestions: page
            .suggestions
            .into_iter()
            .map(|view| view_into_api(view, user))
            .collect(),
        total: page.total,
        offset: page.offset,
        limit: page.limit,
    }
}

fn view_into_api(view: FeedbackSuggestionView, user: &User) -> v0::FeedbackSuggestion {
    let reveal_author =
        user.privileged || view.suggestion.author_id == user.id || !view.suggestion.anonymous;
    view.suggestion
        .into_api(view.vote_count, view.voted, reveal_author)
}

fn parse_product_status(value: Option<String>) -> Result<Option<v0::FeedbackProductStatus>> {
    match value.as_deref() {
        None | Some("") => Ok(None),
        Some("collecting") => Ok(Some(v0::FeedbackProductStatus::Collecting)),
        Some("under_consideration") => Ok(Some(v0::FeedbackProductStatus::UnderConsideration)),
        Some("planned") => Ok(Some(v0::FeedbackProductStatus::Planned)),
        Some("in_progress") => Ok(Some(v0::FeedbackProductStatus::InProgress)),
        Some("released") => Ok(Some(v0::FeedbackProductStatus::Released)),
        Some("not_planned") => Ok(Some(v0::FeedbackProductStatus::NotPlanned)),
        Some(_) => Err(create_error!(InvalidOperation)),
    }
}

fn parse_sort(value: Option<String>) -> Result<v0::FeedbackSort> {
    match value.as_deref() {
        None | Some("") | Some("popular") => Ok(v0::FeedbackSort::Popular),
        Some("new") => Ok(v0::FeedbackSort::New),
        Some(_) => Err(create_error!(InvalidOperation)),
    }
}

fn normalise_create_data(
    mut data: v0::DataCreateFeedbackSuggestion,
) -> Result<v0::DataCreateFeedbackSuggestion> {
    data.title = normalise_required(data.title, "title")?;
    data.description = normalise_required(data.description, "description")?;
    data.validate().map_err(validation_from)?;
    Ok(data)
}

fn normalise_search(search: Option<String>) -> Result<Option<String>> {
    let search = normalise_optional(search)?;
    if search
        .as_ref()
        .is_some_and(|search| search.len() > MAX_QUERY_SEARCH_LENGTH)
    {
        return validation_error("search must be at most 200 characters");
    }
    Ok(search)
}

fn parse_category(value: Option<String>) -> Result<Option<v0::FeedbackCategory>> {
    match value.as_deref() {
        None | Some("") => Ok(None),
        Some("bug") => Ok(Some(v0::FeedbackCategory::Bug)),
        Some("idea") => Ok(Some(v0::FeedbackCategory::Idea)),
        Some(_) => Err(create_error!(InvalidOperation)),
    }
}

fn parse_area(value: Option<String>) -> Result<Option<v0::FeedbackArea>> {
    match value.as_deref() {
        None | Some("") => Ok(None),
        Some("navigation") => Ok(Some(v0::FeedbackArea::Navigation)),
        Some("voice_video") => Ok(Some(v0::FeedbackArea::VoiceVideo)),
        Some("community") => Ok(Some(v0::FeedbackArea::Community)),
        Some("messages") => Ok(Some(v0::FeedbackArea::Messages)),
        Some("moderation") => Ok(Some(v0::FeedbackArea::Moderation)),
        Some("desktop") => Ok(Some(v0::FeedbackArea::Desktop)),
        Some("activities") => Ok(Some(v0::FeedbackArea::Activities)),
        Some("other") => Ok(Some(v0::FeedbackArea::Other)),
        Some(_) => Err(create_error!(InvalidOperation)),
    }
}

fn parse_platform(value: Option<String>) -> Result<Option<v0::FeedbackPlatform>> {
    match value.as_deref() {
        None | Some("") => Ok(None),
        Some("windows") => Ok(Some(v0::FeedbackPlatform::Windows)),
        Some("macos") => Ok(Some(v0::FeedbackPlatform::Macos)),
        Some("linux") => Ok(Some(v0::FeedbackPlatform::Linux)),
        Some("web") => Ok(Some(v0::FeedbackPlatform::Web)),
        Some("android") => Ok(Some(v0::FeedbackPlatform::Android)),
        Some("ios") => Ok(Some(v0::FeedbackPlatform::Ios)),
        Some(_) => Err(create_error!(InvalidOperation)),
    }
}

fn normalise_optional(value: Option<String>) -> Result<Option<String>> {
    value
        .map(|value| normalise_required(value, "value"))
        .transpose()
}

fn normalise_required(value: String, name: &str) -> Result<String> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return validation_error(&format!("{name} must not be blank"));
    }
    Ok(value)
}

fn validation_from(error: validator::ValidationErrors) -> syrnike_result::Error {
    create_error!(FailedValidation {
        error: error.to_string()
    })
}

fn validation_error<T>(error: &str) -> Result<T> {
    Err(create_error!(FailedValidation {
        error: error.to_string()
    }))
}

#[cfg(test)]
fn routes_under_test() -> Vec<rocket::Route> {
    routes![
        list,
        mine,
        detail,
        create,
        add_vote,
        remove_vote,
        admin_pending,
        approve,
        reject,
        merge,
        hide,
        set_status,
        set_response,
    ]
}

#[cfg(test)]
mod tests {
    use authifier::{
        models::{Account, EmailVerification, Session},
        Authifier,
    };
    use rocket::{
        http::{ContentType, Header, Status},
        local::asynchronous::{Client, LocalRequest, LocalResponse},
    };
    use syrnike_database::{Database, DatabaseInfo, FeedbackSuggestion, User};
    use syrnike_models::v0;
    use ulid::Ulid;

    struct FeedbackTestContext {
        client: Client,
        db: Database,
        authifier: Authifier,
    }

    impl FeedbackTestContext {
        async fn new() -> Self {
            let db = DatabaseInfo::Reference
                .connect()
                .await
                .expect("reference database");
            let authifier = db.clone().to_authifier().await;
            let client = Client::tracked(
                rocket::build()
                    .mount("/feedback", super::routes_under_test())
                    .manage(authifier.clone())
                    .manage(db.clone()),
            )
            .await
            .expect("valid rocket instance");

            Self {
                client,
                db,
                authifier,
            }
        }

        async fn user(&self, privileged: bool) -> (User, Session) {
            let id = Ulid::new().to_string();
            let user = User {
                id: id.clone(),
                username: format!("user{}", &id[..8]),
                discriminator: "0001".to_string(),
                privileged,
                ..Default::default()
            };
            self.db.insert_user(&user).await.expect("user inserted");

            let account = Account {
                id,
                email: format!("{}@syrnike13.ru", Ulid::new()),
                password: Default::default(),
                email_normalised: Default::default(),
                deletion: None,
                disabled: false,
                lockout: None,
                mfa: Default::default(),
                password_reset: None,
                verification: EmailVerification::Verified,
            };
            self.authifier
                .database
                .save_account(&account)
                .await
                .expect("account saved");
            let session = account
                .create_session(&self.authifier, String::new())
                .await
                .expect("session created");

            (user, session)
        }

        async fn request_with_session<'r>(
            session: &Session,
            request: LocalRequest<'r>,
        ) -> LocalResponse<'r> {
            request
                .header(Header::new("x-session-token", session.token.to_string()))
                .dispatch()
                .await
        }

        async fn insert_pending(&self, author_id: &str) -> FeedbackSuggestion {
            let suggestion = FeedbackSuggestion::new(
                author_id.to_string(),
                "feedback_author".to_string(),
                "A private proposal".to_string(),
                "A sufficiently detailed private proposal.".to_string(),
                v0::FeedbackCategory::Idea,
                Some(v0::FeedbackArea::Desktop),
                v0::FeedbackPlatform::Windows,
                false,
            );
            self.db
                .insert_feedback_suggestion(&suggestion)
                .await
                .expect("feedback inserted");
            suggestion
        }
    }

    #[rocket::async_test]
    async fn feedback_routes_require_authentication_and_keep_pending_private() {
        let context = FeedbackTestContext::new().await;
        let (author, author_session) = context.user(false).await;
        let (_, other_session) = context.user(false).await;
        let suggestion = context.insert_pending(&author.id).await;

        let anonymous = context
            .client
            .get(format!("/feedback/{}", suggestion.id))
            .dispatch()
            .await;
        assert_eq!(anonymous.status(), Status::Unauthorized);

        let other = FeedbackTestContext::request_with_session(
            &other_session,
            context.client.get(format!("/feedback/{}", suggestion.id)),
        )
        .await;
        assert_eq!(other.status(), Status::NotFound);

        let author_response = FeedbackTestContext::request_with_session(
            &author_session,
            context.client.get(format!("/feedback/{}", suggestion.id)),
        )
        .await;
        assert_eq!(author_response.status(), Status::Ok);
    }

    #[rocket::async_test]
    async fn feedback_admin_actions_require_privileged_user() {
        let context = FeedbackTestContext::new().await;
        let (author, _) = context.user(false).await;
        let (_, normal_session) = context.user(false).await;
        let (_, admin_session) = context.user(true).await;
        let suggestion = context.insert_pending(&author.id).await;

        let denied = FeedbackTestContext::request_with_session(
            &normal_session,
            context
                .client
                .post(format!("/feedback/admin/{}/approve", suggestion.id)),
        )
        .await;
        assert_eq!(denied.status(), Status::Forbidden);

        let approved = FeedbackTestContext::request_with_session(
            &admin_session,
            context
                .client
                .post(format!("/feedback/admin/{}/approve", suggestion.id)),
        )
        .await;
        assert_eq!(approved.status(), Status::Ok);
        let body: v0::FeedbackSuggestion = approved.into_json().await.expect("response body");
        assert_eq!(
            body.moderation_status,
            v0::FeedbackModerationStatus::Approved
        );
        assert_eq!(body.vote_count, 1);

        let create_denied = FeedbackTestContext::request_with_session(
            &normal_session,
            context
                .client
                .post("/feedback/admin/not-a-suggestion/hide")
                .header(ContentType::JSON),
        )
        .await;
        assert_eq!(create_denied.status(), Status::Forbidden);
    }
}
