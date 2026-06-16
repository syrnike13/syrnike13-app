# Badges And Admin UI Design

Status: approved for implementation planning on June 15, 2026.

## Goal

Implement a Discord-like global badge system for user profiles. The system must replace the current numeric badge bitfield with a scalable badge catalog plus per-user assignments, add uploaded PNG/WebP badge icons, and provide a separated admin UI inside the existing web app.

## Existing Code Being Replaced

Current public user models expose badges as a numeric bitfield:

- `services/backend/crates/core/models/src/v0/users.rs`
  - `pub badges: u32`
  - `pub enum UserBadges`
  - `DataEditUser.badges: Option<i32>`
- `services/backend/crates/core/database/src/models/users/model.rs`
  - `pub badges: Option<i32>`
  - `pub async fn get_badges(&self) -> u32`
- `services/backend/crates/core/config/src/lib.rs`
  - `ApiUsers.early_adopter_cutoff: Option<u64>`

This design removes those old badge meanings. There is no backwards compatibility for the old numeric values.

## Product Scope

Visible first-version badges:

- `founder` - Основатель
- `developer` - Разработчик
- `beta_tester` - Бета тестер
- `bug_hunter` - BugHunter
- `partner` - Партнер
- `supporter` - Саппорт / поддержал проект

Reserved premium placeholders:

- `premium_subscriber` - hidden reserved premium badge
- `premium_supporter` - hidden reserved premium badge

Premium placeholders are assignable by admins now, but are hidden from normal user-facing UI until the premium system exists.

Out of scope for the first version:

- chat message row badges
- member list badges
- voice participant badges
- public badge catalog page
- audit-log UI
- migration of old numeric badge meanings

## Data Model

Add a badge catalog model with these fields:

- `id`: stable backend id
- `slug`: unique system slug, editable only in admin UI
- `name`: display name
- `description`: optional display/help text
- `icon_file_id`: optional file id for the badge icon
- `visible`: whether normal user-facing payloads may include this badge
- `premium`: whether this badge is reserved for the future premium/Nitro-like system
- `display_order`: global user-facing order
- `created_at`
- `updated_at`

Add a user badge assignment model with these fields:

- `user_id`
- `badge_id`
- `assigned_by`
- `assigned_at`

The assignment identity is `(user_id, badge_id)`. A user can have a badge only once. User-facing display order is always the badge catalog `display_order`, sorted ascending and then by `slug` ascending as a stable tie-breaker. Per-user badge ordering is not part of this version.

## Migration

The migration should:

- create the badge catalog storage
- create the user badge assignment storage
- seed the initial visible badges and hidden premium placeholders
- stop using `users.badges` as a source of truth
- unset existing `users.badges` values from stored user documents
- remove `UserBadges`
- remove `User::get_badges()`
- remove `config.api.users.early_adopter_cutoff`
- remove badge editing from the generic `PATCH /users/{id}` flow

Because old badge meanings are intentionally discarded, the migration must not map old bit values to new assignments.

## Badge Images

Badge icons use real uploaded image files.

Storage requirements:

- add a dedicated Autumn upload tag: `badges`
- add a dedicated file usage type: `FileUsedForType::BadgeIcon`
- add a local helper equivalent to `File::use_badge_icon(...)`
- allowed MIME types: `image/png`, `image/webp`
- maximum upload size: 10 MB
- required image shape: square
- required dimensions: minimum 64x64, maximum 1024x1024
- generated preview: WebP around 128x128

Admin UI can show incomplete badges without an icon. Normal user-facing UI must not render badges without an icon.

Hard-deleting a badge must:

- delete the badge catalog row
- delete all assignments for that badge
- mark the badge icon file deleted when an icon exists

Deletion must not leave orphan assignments.

## Public API Shape

Public user responses replace the numeric `badges` value with compact badge display data:

```ts
type UserBadge = {
  id: string
  slug: string
  name: string
  description?: string
  icon: File
  order: number
}
```

```ts
type User = {
  // existing user fields
  badges: UserBadge[]
}
```

Normal public user payloads include only badges that are:

- assigned to the user
- `visible === true`
- not hidden premium placeholders
- attached to a valid badge icon

The backend should derive this array from assignments plus the catalog. Frontend code must not need to understand legacy bit values.

## Admin API

All admin routes require privileged backend authorization.

Badge catalog routes:

```text
GET    /admin/badges
POST   /admin/badges
PATCH  /admin/badges/{badge_id}
DELETE /admin/badges/{badge_id}
```

User assignment routes:

```text
GET    /admin/users/{user_id}/badges
PUT    /admin/users/{user_id}/badges/{badge_id}
DELETE /admin/users/{user_id}/badges/{badge_id}
```

`POST /admin/badges` accepts:

```ts
{
  slug: string
  name: string
  description?: string
  icon_file_id?: string
  visible: boolean
  premium: boolean
  display_order: number
}
```

`PATCH /admin/badges/{badge_id}` accepts partial updates for:

- `slug`
- `name`
- `description`
- `icon_file_id`
- `visible`
- `premium`
- `display_order`

`slug` must match `^[a-z0-9_]+$`.

`GET /admin/users/{user_id}/badges` returns the user's assigned badges, including hidden and premium badges, because the admin UI must manage the complete assignment state.

`PUT /admin/users/{user_id}/badges/{badge_id}` is idempotent. Reassigning an already assigned badge succeeds without creating a duplicate.

`DELETE /admin/users/{user_id}/badges/{badge_id}` is idempotent. Removing an already absent assignment succeeds.

When assignments change, prefer sending the existing user update gateway event with refreshed badge data. Add a dedicated badge event only if the current gateway model makes a user update incorrect or awkward.

## Admin Frontend

The admin frontend lives in the existing `apps/web` application, not in a separate deployable app.

Routes:

- `/admin`
- `/admin/badges`

The admin area has its own route group, layout, and sidebar. It is visually separated from the normal app shell. Privileged users get an admin entry point in the current-user profile menu.

Access behavior:

- privileged user: sees admin UI
- non-privileged user opening `/admin`: sees a 404-like missing route state
- normal app shell: does not expose admin navigation to non-privileged users

`/admin/badges` supports:

- list badge catalog entries
- create badge
- edit name
- edit description
- edit slug
- edit visibility
- edit premium/reserved flag
- edit display order
- upload or replace PNG/WebP icon
- hard-delete badge
- search user by username or id
- view a user's assigned badges
- assign badge to user
- remove badge from user

No audit-log UI is included in the first version.

## User-Facing Frontend

Badges render as compact image icons.

Surfaces:

- full global user profile sidebar/card
- current-user profile menu when the current user has visible badges
- other-user profile popovers/menus

Not included in the first version:

- chat message headers
- member sidebar rows
- voice participant rows

Each badge icon needs an accessible label. Hover and focus tooltips should show the badge name and may show the description when present.

## Error Handling

Admin frontend:

- non-privileged `/admin` access renders a 404-like state

Admin backend:

- non-privileged access uses existing unauthorized/forbidden conventions
- missing badge on edit/delete/assign/remove returns `404`
- duplicate `slug` is rejected
- invalid `slug` is rejected
- invalid icon file type, size, or dimensions is rejected

Idempotency:

- repeated assignment with `PUT` succeeds
- repeated removal with `DELETE` succeeds

## Known Code Touchpoints

Backend:

- `services/backend/crates/core/models/src/v0/users.rs`
- `services/backend/crates/core/database/src/models/users/model.rs`
- `services/backend/crates/core/database/src/util/bridge/v0.rs`
- `services/backend/crates/core/config/src/lib.rs`
- `services/backend/crates/core/config/Syrnike.toml`
- `services/backend/crates/core/database/src/models/files/model.rs`
- `services/backend/crates/services/autumn/src/api.rs`
- `services/backend/crates/delta/src/routes/users/edit_user.rs`
- new badge catalog and assignment database models
- new admin badge routes in `services/backend/crates/delta/src/routes`

Frontend:

- `apps/web/src/routes`
- new `/admin` route group
- new admin layout/components
- `apps/web/src/features/api`
- `apps/web/src/features/api/media-api.ts`
- `apps/web/src/lib/media.ts`
- `apps/web/src/components/user/user-global-profile-sidebar.tsx`
- `apps/web/src/components/user/current-user-profile-menu.tsx`
- new shared badge renderer under the existing component organization

Generated/shared API:

- `packages/api-types`
- OpenAPI output/types regenerated through the repo's existing workflow

## Verification Plan

Backend verification:

- model tests for badge catalog CRUD
- model tests for user badge assignment uniqueness and deletion cascade
- route tests for privileged gate
- route tests for idempotent assignment/removal
- route tests for duplicate slug rejection
- migration/seed test for initial catalog
- upload validation tests for the `badges` Autumn tag

Frontend verification:

- `/admin` route gate test
- admin badge list/create/edit/delete UI test
- user search and assignment UI test
- profile badge rendering test
- popover/menu badge rendering test

Commands to run when implementation is complete:

```sh
pnpm web:test
pnpm web:build
pnpm backend:check
```

If backend infrastructure is unavailable locally, record that limitation and run the narrower checks that do not require local services.
