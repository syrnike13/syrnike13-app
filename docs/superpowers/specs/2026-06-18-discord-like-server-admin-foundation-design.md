# Discord-Like Server Admin Foundation Design

Status: approved for foundation-first design on June 18, 2026. Pending user review before implementation planning.

## Goal

Build the foundation for Discord-like server administration in Syrnike13: durable audit logs, correct permission entry points, realtime permission consistency, invite lifecycle, and moderation basics.

This is the first sub-project for the larger server roles/settings objective. The full product goal remains Discord-like server administration, excluding AutoMod, onboarding/community, integrations marketplace, forum channels, stage channels, and thread channels.

## Non-Goals

Do not build these modules in this project:

- AutoMod.
- Onboarding/community.
- Integrations marketplace.
- Forum channels.
- Stage channels.
- Thread channels.

Do not add backwards compatibility layers for old API shapes unless explicitly requested. When an existing shape changes, migrate stored data and generated API types forward.

## Existing State

Server settings are currently a small surface:

```ts
// apps/web/src/components/servers/server-settings-types.ts
export type ServerSettingsTab = 'general' | 'emoji' | 'roles' | 'members'
```

Server settings entry is currently too narrow. `getServerMenuPermissions()` exposes settings only through `ManageServer`, even though role and permission management need their own entry points:

```ts
// apps/web/src/lib/permissions.ts
return {
  invite: canInvite,
  settings: canManageServer,
  createChannel: hasChannelPermission(
    serverPermissions,
    ChannelPermission.ManageChannel,
  ),
  leave: Boolean(member),
  copyId: Boolean(member),
}
```

Invites are currently minimal and do not model Discord-like lifecycle:

```rust
// services/backend/crates/core/database/src/models/channel_invites/model.rs
Server {
    code: String,
    server: String,
    creator: String,
    channel: String,
}
```

Realtime events already exist for role and member changes:

```rust
// services/backend/crates/core/database/src/events/client.rs
ServerMemberUpdate { id, data, clear }
ServerMemberJoin { id, user, member }
ServerMemberLeave { id, user, reason }
ServerRoleUpdate { id, role_id, data, clear }
ServerRoleDelete { id, role_id }
ServerRoleRanksUpdate { id, ranks }
```

But the frontend currently ignores the full `ServerMemberJoin.member` payload and creates a stub member instead:

```ts
// apps/web/src/features/sync/sync-store.ts
this.upsertMembers([
  {
    _id: { server: serverId, user: userId },
  } as Member,
])
```

Role deletion cleanup only unsets channel role permissions on one channel:

```rust
// services/backend/crates/core/database/src/models/servers/ops/mongodb.rs
self.col::<Document>("channels")
    .update_one(
        doc! { "server": server_id },
        doc! { "$unset": { "role_permissions.".to_owned() + role_id: 1_i32 } },
    )
```

Mass `@everyone` mention handling currently fetches all server members for the everyone path. Role mentions filter through `members_can_see_channel()`, but everyone mentions must also filter channel visibility before unread/notification effects:

```rust
// services/backend/crates/daemons/pushd/src/consumers/inbound/mass_mention.rs
let mut db_query = self
    .db
    .fetch_all_members_chunked(&payload.server_id)
    .await?;
```

## Product Shape

The foundation enables these Discord-like settings areas:

| Area | First foundation behavior |
| --- | --- |
| Audit Log | Durable server audit log for admin actions with actor, target, action, reason, diff, and status. |
| Roles | Correct role edit/delete/reorder auditing and realtime permission recalculation. |
| Members | Moderation actions, role edits, nickname/avatar moderation, timeout, kick, ban, unban are auditable. |
| Invites | Create/list/revoke/delete server invites with expiry, max uses, use count, creator, channel, and audit records. |
| Permissions | Settings entry points and route checks match actual section permissions, not only `ManageServer`. |
| Realtime | Role/member/default/channel permission changes update current visibility and member cache correctly. |

Later sub-projects build the broader settings UI on top of this: channel/category permission management, per-user overwrites, server notification defaults, richer server overview/profile fields, ban list UX, invite management UX, audit log UX, and any remaining Discord-like settings that are not explicitly excluded.

## Architecture

Use a foundation-first architecture:

1. Add a server audit log domain in backend core database/model layers.
2. Route all admin mutations through explicit permission checks and audit helpers.
3. Fix permission/realtime invariants before expanding UI.
4. Extend invite/moderation models and APIs.
5. Generate frontend API types after backend schema changes.
6. Expand frontend server settings navigation only after the backing permissions and APIs are correct.

The key rule: no route may return success for an audited admin mutation unless the audit write for that mutation succeeded.

## Audit Log Design

Create a `server_audit_logs` database model, following existing database domain structure:

- `services/backend/crates/core/models/src/v0/server_audit_logs.rs`
- `services/backend/crates/core/database/src/models/server_audit_logs/model.rs`
- `services/backend/crates/core/database/src/models/server_audit_logs/ops.rs`
- `services/backend/crates/core/database/src/models/server_audit_logs/ops/mongodb.rs`
- `services/backend/crates/core/database/src/models/server_audit_logs/ops/reference.rs`

Audit entry fields:

| Field | Meaning |
| --- | --- |
| `_id` | ULID audit entry id. |
| `server_id` | Server where the action happened. |
| `actor_id` | User who initiated the action. |
| `action` | Stable enum action. |
| `target` | Target type and id. |
| `reason` | Optional moderation/admin reason. |
| `changes` | Field-level before/after diff when applicable. |
| `status` | `Pending`, `Succeeded`, or `Failed`. |
| `error` | Sanitized failure string for failed attempts. |
| `request_id` | Optional request correlation id when available. |
| `created_at` | Millisecond timestamp. |
| `completed_at` | Millisecond timestamp when succeeded/failed. |

Action enum first version:

- `ServerUpdate`
- `RoleCreate`
- `RoleUpdate`
- `RoleDelete`
- `RoleReorder`
- `MemberUpdate`
- `MemberKick`
- `MemberBan`
- `MemberUnban`
- `MemberTimeout`
- `InviteCreate`
- `InviteUpdate`
- `InviteRevoke`
- `InviteDelete`
- `ChannelPermissionUpdate`
- `ServerPermissionUpdate`

Audit target enum:

- `Server { id }`
- `Role { id }`
- `Member { user_id }`
- `User { id }`
- `Invite { code }`
- `Channel { id }`
- `Category { id }`

Audit mutation helper:

- Validate actor/session.
- Fetch before state.
- Check permissions.
- Build diff and audit entry.
- Insert audit entry with `Pending`.
- Apply domain mutation.
- Mark audit entry `Succeeded`.
- Return success only after the `Succeeded` write succeeds.
- If mutation fails after pending audit insertion, mark `Failed` and return the original domain error.

This pattern is chosen because the current database abstraction does not expose a general transaction API. If transaction support is added later, the helper can run the domain mutation and audit finalization inside one transaction without changing route-level behavior.

Audit read API:

- `GET /servers/{server}/audit-log`
- Requires `ManageServer` for the first version.
- Supports cursor pagination by `(created_at, _id)`.
- Supports filters: action, actor, target type, target id.
- Does not expose internal error stack traces.

## Permission Entry Point Design

Frontend:

- Replace the single `settings: canManageServer` gate with section-aware access.
- Add helpers in `apps/web/src/lib/permissions.ts`:
  - `getServerSettingsAccess(server, channels, member, userId)`
  - `canOpenServerSettings(access)`
  - `canViewServerSettingsTab(access, tab)`
- Server settings menu appears if the user can access any settings section.
- Tabs render only when the user has the matching permission.

First tab permission mapping:

| Tab | Permission |
| --- | --- |
| Overview/Profile | `ManageServer` |
| Emoji | `ManageCustomisation` |
| Roles | `ManageRole` |
| Role permissions | `ManagePermissions` |
| Members | `KickMembers`, `BanMembers`, `TimeoutMembers`, `AssignRoles`, `ManageNicknames`, or `ManageServer` |
| Invites | `InviteOthers` for create, `ManageServer` for list/revoke all |
| Bans | `BanMembers` |
| Audit Log | `ManageServer` |
| Channels/Categories | `ManageChannel` or `ManagePermissions` depending on action |
| Notifications | `ManageServer` for defaults |

Backend:

- Keep route checks explicit.
- Do not reuse `ManageServer` as a generic shortcut for role, member, channel, or invite mutations unless Discord-like semantics actually allow it.
- Preserve owner bypass where existing backend semantics already use it.
- Add tests where frontend and backend permission helpers can drift.

## Realtime And Security Invariants

Required invariants:

1. Role deletion removes the role from all members and all channel role permission maps.
2. Role rank reorder causes visibility recalculation for affected sessions.
3. Role permission updates cause visibility recalculation for affected sessions.
4. Server default permission updates cause visibility recalculation.
5. Member role/timeout updates update loaded member state and recalculate the current user's visibility when relevant.
6. `ServerMemberJoin` inserts the full member payload, not a stub.
7. `ServerMemberUpdate` should either load or upsert enough member state to avoid silently losing updates for unloaded members.
8. Current user removal from a server cleans up server, channels, selected server, members, unreads, and subscriptions.
9. `@everyone` and `@online` unread/notification fanout must filter through channel visibility just like role mentions.
10. Channel permission changes must be reflected as visible channel create/delete/update effects for current sessions.

Known backend fixes in this foundation:

- Change Mongo role deletion channel cleanup from `update_one` to `update_many`.
- Add bonfire handling for `ServerRoleRanksUpdate`.
- Audit and test current-user removal paths.
- Filter everyone mentions with `members_can_see_channel()` before adding mentions/unreads/notifications.

Known frontend fixes in this foundation:

- Use `ServerMemberJoin.member`.
- Do not ignore `ServerMemberUpdate` for members that should now be represented locally.
- Clean up current-user leave/ban/kick from server state.
- Add tests for settings access and sync event application.

## Invite Lifecycle Design

Replace the current minimal server invite shape with lifecycle fields:

| Field | Meaning |
| --- | --- |
| `code` | Invite code. |
| `server` | Server id. |
| `creator` | Creator user id. |
| `channel` | Target channel id. |
| `created_at` | Creation timestamp. |
| `expires_at` | Optional expiry timestamp. |
| `max_uses` | Optional max use count. |
| `uses` | Current successful use count. |
| `revoked_at` | Optional revocation timestamp. |
| `revoked_by` | Optional revoking user id. |
| `temporary` | Whether membership is temporary. Stored and surfaced in this foundation. Automatic removal of temporary members after disconnect is a named follow-up requirement for the full Discord-like objective, not part of this foundation slice. |

API changes:

- `POST /channels/{channel}/invites` accepts create options: `max_age_seconds`, `max_uses`, `temporary`, `reason`.
- `GET /servers/{server}/invites` returns lifecycle fields.
- `DELETE /invites/{code}` revokes/deletes according to existing route semantics, but must audit.
- `POST /invites/{code}` rejects expired, revoked, or exhausted invites.
- Successful join increments `uses`.

Migration:

- Existing server invites are migrated to the new shape with `created_at` set to migration time, `uses = 0`, no expiry, no max uses, not revoked, `temporary = false`.
- Group invite behavior remains supported with equivalent lifecycle fields only if the existing group invite API needs it. Server admin UI focuses on server invites.

## Moderation Foundation Design

Existing routes already cover core moderation:

- `PUT /servers/{server}/bans/{target}`
- `DELETE /servers/{server}/bans/{target}`
- `GET /servers/{server}/bans`
- `DELETE /servers/{server}/members/{member}`
- `PATCH /servers/{server}/members/{member}`

Foundation changes:

- Add optional `reason` where a moderation route does not already accept one.
- Audit kick, ban, unban, timeout, member role changes, nickname changes, avatar removals, voice moderation, and delete-message-window bans.
- Ensure rank/elevation checks are consistent across kick, ban, timeout, role assignment, and member edit.
- Keep reasons optional because Discord allows empty audit reasons; UI should offer a reason field where useful.

## Frontend Settings Foundation

Expand settings tab types only for sections backed by working APIs:

- `overview`
- `roles`
- `members`
- `bans`
- `invites`
- `audit`
- `emoji`

Do not add disabled placeholders for excluded features.

Navigation should use grouped, Discord-like sections:

| Group | Tabs |
| --- | --- |
| Server | Overview |
| User Management | Members, Roles, Bans |
| Moderation | Audit Log |
| Invites | Invites |
| Expression | Emoji |

The foundation UI does not need to be visually final, but it must not expose actions the current user cannot perform.

## Testing Strategy

Backend tests:

- Audit model insert/fetch/finalize tests for Mongo and Reference DB.
- Route tests proving audited mutations do not return success when audit finalization fails.
- Role deletion cleanup updates all channels.
- Role rank reorder recalculates visibility.
- Invite create/list/join/revoke lifecycle.
- Expired/revoked/exhausted invite rejection.
- Ban/kick/unban/member edit audit entries.
- Everyone mention fanout respects channel visibility.

Frontend tests:

- `apps/web/src/lib/permissions.test.ts` covers section-aware settings access.
- Server settings route tests cover redirect only when no section is accessible.
- Sync store tests cover `ServerMemberJoin.member`, `ServerMemberUpdate`, current-user removal, role delete, and role reorder.
- Invite settings tests cover list/revoke/create controls once API wrappers exist.

Verification commands:

```sh
pnpm web:test
pnpm web:build
pnpm backend:check
```

Use narrower commands while implementing a single slice, but the foundation is not complete until the relevant web and backend checks pass or documented environment blockers are explained.

## Implementation Order

1. Audit log model, storage, and read API.
2. Mandatory audit helper for selected admin mutations.
3. Permission entrypoint fixes in frontend and backend tests around role/settings access.
4. Realtime/security fixes: role cleanup, role reorder visibility, member join/update, current-user removal, everyone visibility filtering.
5. Invite lifecycle model/API/migration.
6. Moderation audit coverage and reason fields.
7. Frontend settings navigation expansion for backed sections.
8. Focused UI panels for audit log, invites, bans, and member moderation basics.

## Open Decisions Already Resolved

- Audit log is mandatory for admin mutations.
- Foundation-first is the implementation order.
- Reasons remain optional.
- No backwards compatibility layer is added for old invite/server-admin API shapes.
- Excluded Discord areas are not shown as placeholders.

## User Review Notes

This document deliberately scopes the first implementation plan to the foundation. It does not redefine the larger goal. After this spec is accepted, the implementation plan should break work into independent, testable tasks and use subagent-driven development where write scopes can stay disjoint.
