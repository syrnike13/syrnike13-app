use syrnike_database::{Member, Server, User};
use syrnike_result::{create_error, Result};

pub fn bypasses_hierarchy(user: &User, server: &Server) -> bool {
    user.privileged || user.id == server.owner
}

pub fn role_is_at_or_above_actor(actor_rank: Option<i64>, role_rank: i64) -> bool {
    role_rank <= actor_rank.unwrap_or(i64::MIN)
}

pub fn ensure_role_below_actor(
    user: &User,
    server: &Server,
    actor_rank: Option<i64>,
    role_rank: i64,
) -> Result<()> {
    if !bypasses_hierarchy(user, server) && role_is_at_or_above_actor(actor_rank, role_rank) {
        return Err(create_error!(NotElevated));
    }

    Ok(())
}

pub fn ensure_member_below_actor(
    user: &User,
    server: &Server,
    actor_rank: Option<i64>,
    member: &Member,
) -> Result<()> {
    if !bypasses_hierarchy(user, server)
        && (member.id.user == server.owner
            || role_is_at_or_above_actor(actor_rank, member.get_ranking(server)))
    {
        return Err(create_error!(NotElevated));
    }

    Ok(())
}
