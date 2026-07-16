# Nightly Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fully independent nightly channel driven by the `develop` branch.

**Architecture:** Production stays on `main`, `/opt/syrnike13`, `syrnike13.ru`, stable Docker tags, and stable desktop auto-update. Nightly runs from `develop`, `/opt/syrnike13-nightly`, `beta.syrnike13.ru`, separate Docker tags, separate data/config/secrets, and GitHub prerelease desktop installers without auto-update.

**Tech Stack:** GitHub Actions, Docker Compose, Caddy, Electron Builder, Vite, pnpm.

---

### Task 1: Desktop Release Identity

**Files:**
- Modify: `apps/desktop/src/main/desktop-app-identity.ts`
- Modify: `apps/desktop/src/main/deep-links.ts`
- Modify: `apps/desktop/src/main/auto-update.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/tsup.config.ts`
- Modify: `apps/desktop/src/main/env.d.ts`
- Modify: `apps/desktop/src/main/*test.ts`
- Create: `apps/desktop/electron-builder.config.cjs`

- [ ] Add release-channel metadata for stable and nightly.
- [ ] Verify stable defaults with existing desktop tests.
- [ ] Add nightly tests for app id, protocol, public host, and disabled auto-update.
- [ ] Move Electron Builder config from `package.json` into an env-aware config file.

### Task 2: Web Build Parameterization

**Files:**
- Modify: `apps/web/Dockerfile`
- Modify: `.github/workflows/release-images-and-deploy.yml`

- [ ] Replace hard-coded production Vite URLs with Docker build args.
- [ ] Pass stable production values from the existing stable workflow.
- [ ] Verify the web Dockerfile still has production defaults.

### Task 3: Nightly Deploy Files

**Files:**
- Create: `deploy/nightly/compose.yml`
- Create: `deploy/nightly/scripts/deploy-on-server.sh`
- Modify: `deploy/production/Caddyfile`
- Modify: `deploy/production/compose.yml`
- Modify: `deploy/production/scripts/deploy-on-server.sh`
- Modify: `deploy/production/generate_config.sh`

- [ ] Add shared external Docker network creation.
- [ ] Attach production Caddy to the shared edge network.
- [ ] Add a beta site block that proxies to nightly service aliases.
- [ ] Add a nightly compose project with separate images, volumes, service names, and LiveKit ports.
- [ ] Make generated LiveKit ports configurable while preserving production defaults.

### Task 4: Nightly GitHub Actions

**Files:**
- Create: `.github/workflows/nightly-release-and-deploy.yml`

- [ ] Build all nightly images on push to `develop`.
- [ ] Deploy those images to `/opt/syrnike13-nightly`.
- [ ] Build desktop installers with nightly identity and beta web URLs.
- [ ] Publish installers to a moving GitHub prerelease named `nightly`.

### Task 5: Verification

**Commands:**
- `pnpm --filter @syrnike13/desktop test`
- `pnpm --filter @syrnike13/desktop typecheck`
- `pnpm web:build`
- Docker Compose config validation for production and nightly.
- SSH read-only checks before any server mutation.

- [ ] Run local checks.
- [ ] Prepare server network and edge routing only after config validation.
- [ ] Do not restart production app services unless required; restart or reload only Caddy for routing changes.
