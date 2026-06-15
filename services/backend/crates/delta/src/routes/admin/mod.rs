use revolt_okapi::openapi3::OpenApi;
use rocket::Route;
use syrnike_database::User;
use syrnike_result::{create_error, Result};

mod badges;
mod user_badges;

fn require_privileged(user: &User) -> Result<()> {
    if user.privileged {
        Ok(())
    } else {
        Err(create_error!(NotPrivileged))
    }
}

pub fn routes() -> (Vec<Route>, OpenApi) {
    openapi_get_routes_spec![
        badges::list,
        badges::create,
        badges::edit,
        badges::delete,
        user_badges::list,
        user_badges::assign,
        user_badges::remove,
    ]
}
