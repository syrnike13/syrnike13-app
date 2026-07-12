use iso8601_timestamp::Timestamp;
use syrnike_result::Result;

use crate::PendingServerMember;
use crate::ReferenceDb;
use crate::{FieldsMember, Member, MemberCompositeKey, PartialMember};

use super::{AbstractServerMembers, ChunkedServerMembersGenerator};

#[async_trait]
impl AbstractServerMembers for ReferenceDb {
    /// Insert a new server member into the database
    async fn insert_or_merge_member(&self, member: &Member) -> Result<Option<Member>> {
        let mut server_members = self.server_members.lock().await;
        let mut pending_server_members = self.pending_server_members.lock().await;

        if server_members.contains_key(&member.id) {
            return Err(create_error!(AlreadyInServer));
        }

        if let Some(pending) = pending_server_members.remove(&member.id) {
            let mut restored = pending.member;
            restored.joined_at = member.joined_at;
            restored.temporary = member.temporary;
            server_members.insert(restored.id.clone(), restored.clone());
            Ok(Some(restored))
        } else {
            server_members.insert(member.id.clone(), member.clone());
            Ok(None)
        }
    }

    /// Fetch a server member by their id
    async fn fetch_member(&self, server_id: &str, user_id: &str) -> Result<Member> {
        let server_members = self.server_members.lock().await;
        server_members
            .get(&MemberCompositeKey {
                server: server_id.to_string(),
                user: user_id.to_string(),
            })
            .cloned()
            .ok_or_else(|| create_error!(NotFound))
    }

    /// Fetch all members in a server
    async fn fetch_all_members(&self, server_id: &str) -> Result<Vec<Member>> {
        let server_members = self.server_members.lock().await;
        Ok(server_members
            .values()
            .filter(|member| member.id.server == server_id)
            .cloned()
            .collect())
    }

    /// Fetch all members in a server as an iterator
    async fn fetch_all_members_chunked(
        &self,
        server_id: &str,
    ) -> Result<ChunkedServerMembersGenerator> {
        let server_members = self.server_members.lock().await;

        let members = server_members
            .clone()
            .into_values()
            .filter(move |member| member.id.server == server_id)
            .collect();

        // this is inefficient as shit but its the reference db so its fine
        Ok(ChunkedServerMembersGenerator::new_reference(members))
    }

    /// Fetch all members that have any of the roles given
    async fn fetch_all_members_with_roles(
        &self,
        server_id: &str,
        roles: &[String],
    ) -> Result<Vec<Member>> {
        let server_members = self.server_members.lock().await;

        Ok(server_members
            .clone()
            .into_values()
            .filter(|member| {
                member.id.server == server_id
                    && !member
                        .roles
                        .iter()
                        .filter(|p| roles.contains(*p))
                        .collect::<Vec<&String>>()
                        .is_empty()
            })
            .collect())
    }

    async fn fetch_all_members_with_roles_chunked(
        &self,
        server_id: &str,
        roles: &[String],
    ) -> Result<ChunkedServerMembersGenerator> {
        let server_members = self.server_members.lock().await;

        let resp = server_members
            .clone()
            .into_values()
            .filter(|member| {
                member.id.server == server_id
                    && !member
                        .roles
                        .iter()
                        .filter(|p| roles.contains(*p))
                        .collect::<Vec<&String>>()
                        .is_empty()
            })
            .collect();

        return Ok(ChunkedServerMembersGenerator::new_reference(resp));
    }

    /// Fetch all memberships for a user
    async fn fetch_all_memberships(&self, user_id: &str) -> Result<Vec<Member>> {
        let server_members = self.server_members.lock().await;
        Ok(server_members
            .values()
            .filter(|member| member.id.user == user_id)
            .cloned()
            .collect())
    }

    /// Fetch multiple members by their ids
    async fn fetch_members(&self, server_id: &str, ids: &[String]) -> Result<Vec<Member>> {
        let server_members = self.server_members.lock().await;
        Ok(ids
            .iter()
            .filter_map(|id| {
                server_members
                    .get(&MemberCompositeKey {
                        server: server_id.to_string(),
                        user: id.to_string(),
                    })
                    .cloned()
            })
            .collect())
    }

    /// Fetch member count of a server
    async fn fetch_member_count(&self, server_id: &str) -> Result<usize> {
        let server_members = self.server_members.lock().await;
        Ok(server_members
            .values()
            .filter(|member| member.id.server == server_id)
            .count())
    }

    /// Fetch server count of a user
    async fn fetch_server_count(&self, user_id: &str) -> Result<usize> {
        let server_members = self.server_members.lock().await;
        Ok(server_members
            .values()
            .filter(|member| member.id.user == user_id)
            .count())
    }

    /// Update information for a server member
    async fn update_member(
        &self,
        id: &MemberCompositeKey,
        partial: &PartialMember,
        remove: Vec<FieldsMember>,
    ) -> Result<()> {
        let mut server_members = self.server_members.lock().await;
        if let Some(member) = server_members.get_mut(id) {
            for field in remove {
                #[allow(clippy::disallowed_methods)]
                member.remove_field(&field);
            }

            member.apply_options(partial.clone());
            Ok(())
        } else {
            Err(create_error!(NotFound))
        }
    }

    /// Soft delete a member
    async fn soft_delete_member(&self, id: &MemberCompositeKey) -> Result<()> {
        let mut server_members = self.server_members.lock().await;
        let Some(mut member) = server_members.remove(id) else {
            return Err(create_error!(NotFound));
        };

        if member.in_timeout() {
            let pending_deletion_at = member.timeout.expect("timed out member has a timeout");
            member.avatar = None;
            member.nickname = None;
            member.roles.clear();
            member.temporary = false;

            let mut pending_server_members = self.pending_server_members.lock().await;
            pending_server_members.insert(
                id.clone(),
                PendingServerMember {
                    member,
                    pending_deletion_at,
                },
            );
        }

        Ok(())
    }

    /// Delete a server member by their id
    async fn force_delete_member(&self, id: &MemberCompositeKey) -> Result<()> {
        let mut server_members = self.server_members.lock().await;
        let mut pending_server_members = self.pending_server_members.lock().await;
        server_members.remove(id);
        pending_server_members.remove(id);
        Ok(())
    }

    async fn remove_dangling_members(&self) -> Result<()> {
        let now = Timestamp::now_utc();
        let mut pending_server_members = self.pending_server_members.lock().await;
        pending_server_members.retain(|_, member| member.pending_deletion_at >= now);
        Ok(())
    }
}
