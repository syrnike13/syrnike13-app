# Admin App Design

## Decision

Build the admin UI as a separate frontend application, not as a section inside
the main web client.

The admin app will live in `apps/admin` and be deployed as a separate static
frontend bundle.

## Domains

- Production admin: `https://admin.syrnike13.ru`
- Nightly admin: `https://admin.beta.syrnike13.ru`

The admin app has separate production and nightly builds. Production points to
the production backend. Nightly points to the nightly backend.

## Backend And Accounts

The admin frontend uses the existing backend and the same user accounts as the
main application.

- Production API: `https://syrnike13.ru/api`
- Nightly API: `https://beta.syrnike13.ru/api`
- Existing admin endpoints remain under `/admin/*`.
- Existing auth endpoints remain the source of login/session behavior.

No separate admin backend is introduced in this phase.

## Authentication

The admin app has its own login screen and its own browser-local session.

This means a user who is already logged into `syrnike13.ru` may still need to
log into `admin.syrnike13.ru`. That is intentional for the first version because
the current web session is stored in `localStorage`, which is scoped per origin.

After login, the admin app loads the current user and requires:

```ts
user.privileged === true
```

If the user is not privileged, the app must not render admin screens. It should
show an access denied or not found state and avoid making privileged admin
queries.

## Frontend Boundary

The current admin route code in `apps/web/src/routes/admin/*` becomes admin app
code under `apps/admin`.

The main web app should stop owning admin screens. If `/admin` remains in
`apps/web`, it should only redirect to the correct admin domain or be removed
entirely.

The admin app should not inherit messenger-specific shell behavior:

- no desktop route guards;
- no mobile route remapping;
- no messenger sync provider unless a concrete admin feature needs it;
- no voice/events gateway connection by default.

This keeps the admin UI focused on operational workflows instead of coupling it
to the messenger runtime.

## Shared Code

Reuse existing package dependencies and simple modules where it avoids copying
real logic:

- API request helper patterns;
- auth request functions;
- generated API types from `@syrnike13/api-types`;
- basic UI components if they are already generic.

Do not create a large shared admin framework upfront. Move code only when both
apps actually need the same behavior.

## Deployment

Add an admin frontend image and route it through the existing production edge.

Production:

- build an admin image for release;
- route `admin.syrnike13.ru` to the production admin container;
- configure the admin frontend to call `https://syrnike13.ru/api`.

Nightly:

- build an admin image tagged for nightly;
- route `admin.beta.syrnike13.ru` to the nightly admin container;
- configure the admin frontend to call `https://beta.syrnike13.ru/api`.

The production Caddy container remains the public edge for both production and
nightly domains.

## Testing

Minimum verification for the first implementation:

- admin app builds successfully;
- admin login uses the selected environment API URL;
- non-privileged users cannot render admin screens;
- privileged users can open the migrated badge admin screen;
- production Caddy routes `admin.syrnike13.ru` to the production admin frontend;
- nightly Caddy routes `admin.beta.syrnike13.ru` to the nightly admin frontend.

## Out Of Scope

- shared cross-subdomain SSO;
- a separate admin backend service;
- audit log;
- impersonation;
- granular admin role permissions beyond the existing `privileged` flag.
