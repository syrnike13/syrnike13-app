# Badges Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy user badge bitfield with a catalog-and-assignment badge system, badge icon uploads, user-facing badge rendering, and a separated `/admin/badges` UI.

**Architecture:** Badges become a backend domain model with two storage concepts: catalog rows and per-user assignments. Public user payloads expose only renderable visible assigned badges, while admin routes expose full catalog and assignment state. Frontend changes use a small admin API client, a dedicated admin route group, and one shared badge renderer for profile surfaces.

**Tech Stack:** Rust/Rocket backend, MongoDB/reference database abstraction, Autumn media service, generated OpenAPI TypeScript types, React/TanStack Router/TanStack Query frontend, Vitest.

---

## File Structure

Backend models and storage:

- Create `services/backend/crates/core/models/src/v0/badges.rs` for public/admin badge API types.
- Modify `services/backend/crates/core/models/src/v0/mod.rs` to export badge models.
- Create `services/backend/crates/core/database/src/models/badges/mod.rs`.
- Create `services/backend/crates/core/database/src/models/badges/model.rs` for `Badge`, `PartialBadge`, `UserBadgeAssignment`, seed data, validation helpers, and conversion helpers.
- Create `services/backend/crates/core/database/src/models/badges/ops.rs` for the abstract badge database trait.
- Create `services/backend/crates/core/database/src/models/badges/ops/reference.rs` for in-memory tests/dev storage.
- Create `services/backend/crates/core/database/src/models/badges/ops/mongodb.rs` for MongoDB storage.
- Modify `services/backend/crates/core/database/src/models/mod.rs` to include the badges trait.
- Modify `services/backend/crates/core/database/src/drivers/reference.rs` to add badge maps.
- Modify `services/backend/crates/core/database/src/util/bridge/v0.rs` to convert assigned badges into public `User.badges`.

Backend migration/config/upload:

- Modify `services/backend/crates/core/database/src/models/admin_migrations/ops/mongodb/scripts.rs` to add a new revision that creates badge collections, creates indexes, seeds initial catalog rows, and unsets `users.badges`.
- Modify `services/backend/crates/core/models/src/v0/users.rs` to remove `UserBadges`, remove numeric `User.badges`, add `Vec<UserBadge>`, and remove `DataEditUser.badges`.
- Modify `services/backend/crates/core/database/src/models/users/model.rs` to remove `badges`, `get_badges()`, and early adopter imports.
- Modify user storage ops to stop persisting/updating `badges`.
- Modify `services/backend/crates/core/config/src/lib.rs` and `services/backend/crates/core/config/Syrnike.toml` to remove `early_adopter_cutoff`.
- Modify `services/backend/crates/core/database/src/models/files/model.rs` to add `FileUsedForType::BadgeIcon` and `File::use_badge_icon(...)`.
- Modify `services/backend/crates/services/autumn/src/api.rs` to add the `badges` upload tag with PNG/WebP, 10 MB, square 64-1024 validation, and 128 WebP preview settings following existing tag patterns.

Backend routes:

- Create `services/backend/crates/delta/src/routes/admin/mod.rs`.
- Create `services/backend/crates/delta/src/routes/admin/badges.rs`.
- Create `services/backend/crates/delta/src/routes/admin/user_badges.rs`.
- Modify `services/backend/crates/delta/src/routes/mod.rs` to mount `/admin`.
- Modify `services/backend/crates/delta/src/routes/users/edit_user.rs` to remove badge editing.

Frontend API/UI:

- Create `apps/web/src/features/api/admin-api.ts`.
- Modify `apps/web/src/features/api/media-api.ts` to include the `badges` upload tag.
- Modify `apps/web/src/lib/api/query-keys.ts` to include admin badge keys.
- Create `apps/web/src/components/user/user-badges.tsx`.
- Modify `apps/web/src/components/user/user-global-profile-sidebar.tsx`.
- Modify `apps/web/src/components/user/user-profile-card-header.tsx` or `apps/web/src/components/user/user-profile-card.tsx`.
- Modify `apps/web/src/components/user/current-user-profile-menu.tsx`.
- Create `apps/web/src/routes/admin/route.tsx`.
- Create `apps/web/src/routes/admin/index.tsx`.
- Create `apps/web/src/routes/admin/badges.tsx`.
- Modify `apps/web/src/components/user/current-user-profile-menu.tsx` to show a privileged-only admin entry.

Generated types:

- Regenerate `packages/api-types/OpenAPI.json`, `packages/api-types/src/schema.ts`, `packages/api-types/src/types.ts`, and built `dist` output through existing scripts after backend OpenAPI changes.
- Regenerate `apps/web/src/routeTree.gen.ts` through the existing TanStack Router/Vite workflow.

## Task 1: Move Git Work To Feature Branch

**Files:** none

- [x] **Step 1: Create a feature branch containing the spec commit**

Run:

```sh
git switch -c feat/badges-admin-system
```

Expected: the current branch is `feat/badges-admin-system`.

- [x] **Step 2: Move `main` back to `origin/main`**

Run:

```sh
git branch -f main origin/main
```

Expected: `main` and `origin/main` point to the same commit; the spec commit remains on `feat/badges-admin-system`.

## Task 2: Add Badge API Types

**Files:**

- Create: `services/backend/crates/core/models/src/v0/badges.rs`
- Modify: `services/backend/crates/core/models/src/v0/mod.rs`
- Modify: `services/backend/crates/core/models/src/v0/users.rs`

- [ ] **Step 1: Add model tests or compile guards by importing the new types from `v0`**

Add a small unit test in `services/backend/crates/core/models/src/v0/badges.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::RE_BADGE_SLUG;

    #[test]
    fn badge_slug_accepts_only_lowercase_digits_and_underscores() {
        assert!(RE_BADGE_SLUG.is_match("bug_hunter"));
        assert!(RE_BADGE_SLUG.is_match("premium2"));
        assert!(!RE_BADGE_SLUG.is_match("BugHunter"));
        assert!(!RE_BADGE_SLUG.is_match("bug-hunter"));
        assert!(!RE_BADGE_SLUG.is_match(""));
    }
}
```

- [ ] **Step 2: Define `Badge`, `UserBadge`, and admin payload types**

Implement the file with `auto_derived!` / `auto_derived_partial!` patterns used by existing v0 models. Include:

```rust
pub static RE_BADGE_SLUG: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[a-z0-9_]+$").unwrap());
```

and types:

```rust
pub struct Badge { id, slug, name, description, icon, visible, premium, display_order, created_at, updated_at }
pub struct UserBadge { id, slug, name, description, icon, order }
pub struct DataCreateBadge { slug, name, description, icon_file_id, visible, premium, display_order }
pub struct DataEditBadge { slug, name, description, icon_file_id, visible, premium, display_order }
```

- [ ] **Step 3: Change public `User.badges` from `u32` to `Vec<UserBadge>`**

In `services/backend/crates/core/models/src/v0/users.rs`, replace the bitfield field with:

```rust
#[cfg_attr(
    feature = "serde",
    serde(skip_serializing_if = "Vec::is_empty", default)
)]
pub badges: Vec<UserBadge>,
```

Remove `UserBadges` and remove `DataEditUser.badges`.

- [ ] **Step 4: Run backend model check**

Run:

```sh
cargo check --manifest-path services/backend/Cargo.toml -p syrnike-models
```

Expected: compile errors only from downstream database conversions that still expect numeric badges. Fix those in later tasks.

## Task 3: Add Badge Database Models And Storage Ops

**Files:**

- Create: `services/backend/crates/core/database/src/models/badges/mod.rs`
- Create: `services/backend/crates/core/database/src/models/badges/model.rs`
- Create: `services/backend/crates/core/database/src/models/badges/ops.rs`
- Create: `services/backend/crates/core/database/src/models/badges/ops/reference.rs`
- Create: `services/backend/crates/core/database/src/models/badges/ops/mongodb.rs`
- Modify: `services/backend/crates/core/database/src/models/mod.rs`
- Modify: `services/backend/crates/core/database/src/drivers/reference.rs`

- [ ] **Step 1: Write reference storage tests for seed data and assignment uniqueness**

Create tests in `model.rs` using `database_test!`:

```rust
#[cfg(test)]
mod tests {
    use crate::{Badge, UserBadgeAssignment};
    use iso8601_timestamp::Timestamp;

    #[async_std::test]
    async fn inserting_duplicate_badge_slug_fails() {
        database_test!(|db| async move {
            let badge = Badge::new_seed("founder", "Основатель", 0, true, false);
            db.insert_badge(&badge).await.unwrap();
            assert!(db.insert_badge(&badge).await.is_err());
        });
    }

    #[async_std::test]
    async fn assigning_same_badge_twice_is_idempotent() {
        database_test!(|db| async move {
            let badge = Badge::new_seed("founder", "Основатель", 0, true, false);
            db.insert_badge(&badge).await.unwrap();
            let assignment = UserBadgeAssignment {
                user_id: "user".to_string(),
                badge_id: badge.id.clone(),
                assigned_by: "admin".to_string(),
                assigned_at: Timestamp::now_utc(),
            };
            db.assign_user_badge(&assignment).await.unwrap();
            db.assign_user_badge(&assignment).await.unwrap();
            assert_eq!(db.fetch_user_badge_assignments("user").await.unwrap().len(), 1);
        });
    }
}
```

- [ ] **Step 2: Implement `Badge`, `PartialBadge`, `UserBadgeAssignment`, and initial seed rows**

Include `INITIAL_BADGES` or an equivalent function returning the eight approved badges:

```rust
founder, developer, beta_tester, bug_hunter, partner, supporter, premium_subscriber, premium_supporter
```

Premium rows are `visible: false`, `premium: true`.

- [ ] **Step 3: Define `AbstractBadges`**

Add trait methods:

```rust
insert_badge
fetch_badge
fetch_badge_by_slug
fetch_badges
update_badge
delete_badge
assign_user_badge
remove_user_badge
fetch_user_badge_assignments
fetch_user_badges
delete_badge_assignments
```

- [ ] **Step 4: Implement reference ops**

Use `Arc<Mutex<HashMap<String, Badge>>>` and `Arc<Mutex<HashMap<String, UserBadgeAssignment>>>`. The assignment map key is `format!("{}:{}", user_id, badge_id)`.

- [ ] **Step 5: Implement MongoDB ops**

Use collections:

```text
badges
user_badges
```

Use unique indexes in migration for `badges.slug` and `(user_id, badge_id)`.

- [ ] **Step 6: Wire `AbstractBadges` into `AbstractDatabase`**

Modify `models/mod.rs` so `AbstractDatabase` includes `badges::AbstractBadges`.

- [ ] **Step 7: Run focused database tests**

Run:

```sh
cargo test --manifest-path services/backend/Cargo.toml -p syrnike-database badges
```

Expected: badge model/reference tests pass.

## Task 4: Replace Legacy User Bitfield

**Files:**

- Modify: `services/backend/crates/core/database/src/models/users/model.rs`
- Modify: `services/backend/crates/core/database/src/models/users/ops/reference.rs`
- Modify: `services/backend/crates/core/database/src/models/users/ops/mongodb.rs`
- Modify: `services/backend/crates/core/database/src/util/bridge/v0.rs`
- Modify: `services/backend/crates/delta/src/routes/users/edit_user.rs`

- [ ] **Step 1: Remove legacy badge fields from database user model**

Delete `badges: Option<i32>` from `User`/`PartialUser` database models and remove `UserBadges`, `config`, and `Ulid` imports that only supported `get_badges()`.

- [ ] **Step 2: Remove `get_badges()`**

Delete the method:

```rust
pub async fn get_badges(&self) -> u32
```

- [ ] **Step 3: Add badge hydration helpers**

In `bridge/v0.rs`, add a helper that fetches assigned badges and filters public display:

```rust
async fn public_user_badges(db: &Database, user_id: &str) -> Vec<syrnike_models::v0::UserBadge> {
    db.fetch_user_badges(user_id)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter_map(|badge| badge.into_public_user_badge())
        .collect()
}
```

Use it from `into_self` and the public user conversion path.

- [ ] **Step 4: Remove generic user badge editing**

In `edit_user.rs`, remove `data.badges` from privilege checks, empty-change checks, and `PartialUser`.

- [ ] **Step 5: Run backend check and fix compile fallout**

Run:

```sh
cargo check --manifest-path services/backend/Cargo.toml --workspace
```

Expected: remaining errors point to generated/shared type conversions or storage fields; fix them before continuing.

## Task 5: Add Migration, Config Cleanup, And Upload Tag

**Files:**

- Modify: `services/backend/crates/core/database/src/models/admin_migrations/ops/mongodb/scripts.rs`
- Modify: `services/backend/crates/core/config/src/lib.rs`
- Modify: `services/backend/crates/core/config/Syrnike.toml`
- Modify: `services/backend/crates/core/database/src/models/files/model.rs`
- Modify: `services/backend/crates/services/autumn/src/api.rs`

- [ ] **Step 1: Add migration revision**

Increment `LATEST_REVISION` by one and add a migration block:

```rust
if revision <= 50 {
    info!("Running migration [revision 50 / 2026-06-15]: Add user badge catalog.");
    db.db().create_collection("badges").await.ok();
    db.db().create_collection("user_badges").await.ok();
    db.db().run_command(doc! { "createIndexes": "badges", "indexes": [{ "key": { "slug": 1 }, "name": "slug_unique", "unique": true }] }).await.expect("Failed to create badge slug index.");
    db.db().run_command(doc! { "createIndexes": "user_badges", "indexes": [{ "key": { "user_id": 1, "badge_id": 1 }, "name": "user_badge_unique", "unique": true }] }).await.expect("Failed to create user badge index.");
    db.col::<Document>("users").update_many(doc! {}, doc! { "$unset": { "badges": 1_i32 } }).await.expect("Failed to unset legacy user badges.");
}
```

Seed rows should be inserted in the same block with stable ULIDs generated in code or through `Badge::new_seed(...)`.

- [ ] **Step 2: Remove `early_adopter_cutoff`**

Delete it from `ApiUsers` and `Syrnike.toml`.

- [ ] **Step 3: Add `BadgeIcon` file usage**

Add `BadgeIcon` to `FileUsedForType` and:

```rust
pub async fn use_badge_icon(db: &Database, id: &str, parent: &str, uploader_id: &str) -> Result<File> {
    db.find_and_use_attachment(
        id,
        "badges",
        FileUsedFor { id: parent.to_owned(), object_type: FileUsedForType::BadgeIcon },
        uploader_id.to_owned(),
    )
    .await
}
```

- [ ] **Step 4: Add Autumn `badges` tag**

Follow existing tag registration style in `services/backend/crates/services/autumn/src/api.rs`. The tag accepts only PNG/WebP, max 10 MB, square image metadata 64-1024 px, and emits a 128 WebP preview.

## Task 6: Add Admin Backend Routes

**Files:**

- Create: `services/backend/crates/delta/src/routes/admin/mod.rs`
- Create: `services/backend/crates/delta/src/routes/admin/badges.rs`
- Create: `services/backend/crates/delta/src/routes/admin/user_badges.rs`
- Modify: `services/backend/crates/delta/src/routes/mod.rs`

- [ ] **Step 1: Add privileged guard helper**

Use the existing `User` request guard and check:

```rust
if !user.privileged {
    return Err(create_error!(NotPrivileged));
}
```

in every admin handler.

- [ ] **Step 2: Implement catalog routes**

Handlers:

```text
GET    /badges
POST   /badges
PATCH  /badges/<badge_id>
DELETE /badges/<badge_id>
```

Use `File::use_badge_icon(...)` when `icon_file_id` is set. Hard delete marks the previous icon deleted and deletes assignments.

- [ ] **Step 3: Implement assignment routes**

Handlers:

```text
GET    /users/<user_id>/badges
PUT    /users/<user_id>/badges/<badge_id>
DELETE /users/<user_id>/badges/<badge_id>
```

`PUT` and `DELETE` are idempotent.

- [ ] **Step 4: Mount `/admin`**

Add `mod admin;` and mount `"/admin" => admin::routes()` in both API version mount groups.

- [ ] **Step 5: Run route compile check**

Run:

```sh
cargo check --manifest-path services/backend/Cargo.toml -p delta
```

Expected: route crate compiles.

## Task 7: Regenerate API Types

**Files:**

- Modify generated: `packages/api-types/OpenAPI.json`
- Modify generated: `packages/api-types/src/schema.ts`
- Modify generated: `packages/api-types/src/types.ts`
- Modify generated/build output if repo convention requires: `packages/api-types/dist/*`

- [ ] **Step 1: Generate OpenAPI output from backend**

Use the repo's existing backend OpenAPI workflow. If there is no single script, run the backend command that produces `packages/api-types/OpenAPI.json` and document the command used.

- [ ] **Step 2: Generate TypeScript API types**

Run:

```sh
pnpm api-types:generate
pnpm api-types:build
```

Expected: generated types include `Badge`, `UserBadge`, `DataCreateBadge`, and `DataEditBadge`.

## Task 8: Add Frontend Admin API And Badge Renderer

**Files:**

- Create: `apps/web/src/features/api/admin-api.ts`
- Modify: `apps/web/src/features/api/media-api.ts`
- Modify: `apps/web/src/lib/api/query-keys.ts`
- Create: `apps/web/src/components/user/user-badges.tsx`
- Modify: `apps/web/src/lib/media.ts`

- [ ] **Step 1: Add API helpers**

Add functions:

```ts
fetchAdminBadges
createAdminBadge
updateAdminBadge
deleteAdminBadge
fetchAdminUserBadges
assignAdminUserBadge
removeAdminUserBadge
```

Each uses `apiRequest` and the `/admin/...` paths from the spec.

- [ ] **Step 2: Add badge upload tag**

Change:

```ts
export type MediaUploadTag = 'avatars' | 'backgrounds'
```

to include:

```ts
export type MediaUploadTag = 'avatars' | 'backgrounds' | 'badges'
```

- [ ] **Step 3: Add `badgeIconUrl`**

In `media.ts`, add:

```ts
export function badgeIconUrl(icon: File | null | undefined) {
  if (!icon) return null
  return attachmentPreviewUrl(icon)
}
```

- [ ] **Step 4: Add shared badge renderer**

Create `UserBadges` that accepts `badges: User['badges']`, renders compact image icons, and uses accessible labels/tooltips.

## Task 9: Add Admin Frontend Routes

**Files:**

- Create: `apps/web/src/routes/admin/route.tsx`
- Create: `apps/web/src/routes/admin/index.tsx`
- Create: `apps/web/src/routes/admin/badges.tsx`
- Modify generated route tree through the normal route generator/build.

- [ ] **Step 1: Add gated admin layout**

Use `useAuth()`. If `auth.user?.privileged !== true`, render the app's missing-route/404 equivalent or a neutral not-found screen without saying "access denied".

- [ ] **Step 2: Add `/admin` index**

Redirect privileged users to `/admin/badges` or render a simple admin dashboard with a badges nav entry.

- [ ] **Step 3: Add `/admin/badges` UI**

Implement:

- catalog table/list
- create/edit form
- PNG/WebP upload using `uploadMediaFile(token, 'badges', file)`
- hard delete button with confirmation
- user search by id or username
- assigned badge list
- assign/remove controls

Keep UI utilitarian and dense, not a marketing layout.

- [ ] **Step 4: Add profile menu admin entry**

In `current-user-profile-menu.tsx`, show an admin entry only when `auth.user?.privileged === true`. Link to `/admin/badges`.

## Task 10: Add User-Facing Badge Rendering

**Files:**

- Modify: `apps/web/src/components/user/user-global-profile-sidebar.tsx`
- Modify: `apps/web/src/components/user/user-profile-card-header.tsx` or `apps/web/src/components/user/user-profile-card.tsx`
- Modify: `apps/web/src/components/user/current-user-profile-menu.tsx`

- [ ] **Step 1: Render badges in full profile**

Place `UserBadges` near display name/username in `user-global-profile-sidebar.tsx`.

- [ ] **Step 2: Render badges in compact popover**

Place `UserBadges` in the compact profile card header or immediately below it, keeping the popover height stable.

- [ ] **Step 3: Render current-user badges**

Place `UserBadges` in `CurrentUserProfileMenu` below username when the current user has badges.

## Task 11: Tests And Verification

**Files:**

- Add/modify focused backend tests near the changed database models and routes.
- Add/modify frontend tests near user profile components and admin route components.

- [ ] **Step 1: Run backend checks**

Run:

```sh
pnpm backend:check
```

Expected: Rust workspace compiles.

- [ ] **Step 2: Run web tests**

Run:

```sh
pnpm web:test
```

Expected: Vitest suite passes.

- [ ] **Step 3: Run web build**

Run:

```sh
pnpm web:build
```

Expected: Vite build completes and generated route tree is consistent.

- [ ] **Step 4: Manual browser verification**

Start the dev server:

```sh
pnpm web:dev
```

Verify:

- privileged user can open `/admin/badges`
- non-privileged user sees 404-like state for `/admin`
- profile sidebar shows visible assigned badge icons
- popover/current-user menu show visible assigned badge icons
- chat rows/member lists do not show badges

