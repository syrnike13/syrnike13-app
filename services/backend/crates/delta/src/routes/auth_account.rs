use authifier::{
    config::{EmailVerificationConfig, ShieldValidationInput},
    models::Account,
    util::normalise_email,
    Authifier, Error, Result,
};
use revolt_rocket_okapi::{openapi, openapi_get_routes_spec, revolt_okapi::openapi3::OpenApi};
use rocket::{serde::json::Json, State};
use rocket_empty::EmptyResponse;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, JsonSchema)]
pub struct DataCreateAccount {
    pub email: String,
    pub password: String,
    pub invite: Option<String>,
    pub captcha: Option<String>,
}

#[openapi(tag = "Account")]
#[post("/create", data = "<data>")]
pub async fn create_account(
    authifier: &State<Authifier>,
    data: Json<DataCreateAccount>,
    mut shield: ShieldValidationInput,
) -> Result<EmptyResponse> {
    let data = data.into_inner();

    authifier.config.captcha.check(data.captcha).await?;

    shield.email = Some(data.email.to_string());
    authifier.config.shield.validate(shield).await?;

    authifier
        .config
        .email_block_list
        .validate_email(&data.email)?;

    authifier
        .config
        .password_scanning
        .assert_safe(&data.password)
        .await?;

    let invite = if authifier.config.invite_only {
        if let Some(invite) = data.invite {
            Some(authifier.database.find_invite(&invite).await?)
        } else {
            return Err(Error::MissingInvite);
        }
    } else {
        None
    };

    if authifier
        .database
        .find_account_by_normalised_email(&normalise_email(data.email.clone()))
        .await?
        .is_some()
    {
        return Err(Error::IncorrectData { with: "email" });
    }

    let verify_email = matches!(
        authifier.config.email_verification,
        EmailVerificationConfig::Enabled { .. }
    );

    let account = Account::new(authifier, data.email, data.password, verify_email).await?;

    if let Some(mut invite) = invite {
        invite.claimed_by = Some(account.id);
        invite.used = true;

        authifier.database.save_invite(&invite).await?;
    }

    Ok(EmptyResponse)
}

pub fn routes() -> (Vec<rocket::Route>, OpenApi) {
    openapi_get_routes_spec![
        create_account,
        rocket_authifier::routes::account::resend_verification::resend_verification,
        rocket_authifier::routes::account::confirm_deletion::confirm_deletion,
        rocket_authifier::routes::account::fetch_account::fetch_account,
        rocket_authifier::routes::account::delete_account::delete_account,
        rocket_authifier::routes::account::disable_account::disable_account,
        rocket_authifier::routes::account::change_password::change_password,
        rocket_authifier::routes::account::change_email::change_email,
        rocket_authifier::routes::account::verify_email::verify_email,
        rocket_authifier::routes::account::password_reset::password_reset,
        rocket_authifier::routes::account::send_password_reset::send_password_reset
    ]
}
