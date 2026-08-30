# Repository guide

## Working rules

- Use `pnpm` and prefer the narrowest command for the affected package or service.
- Search with `rg`/`rg --files`; never search inside `node_modules`.
- Never use `fork_context=true` for subagents, and wait for delegated work to finish before relying on it.
- Preserve unrelated user changes in a dirty worktree. Use `apply_patch` for manual edits and avoid destructive Git commands.
- For bugs, find the architectural cause. Ask before changing architecture, security boundaries, or public behavior.
- Prefer small, explicit, production-friendly APIs. Do not add compatibility paths or wrappers unless requested.
- The user does not see code by default, so explanations must cite concrete files and relevant snippets.
- Do not create issues, branches, PRs, comments, deployments, or external side effects unless requested.
- For manual-save UI, register dirty state with the shared draft controller and show `UnsavedChangesBar` with save and reset actions.
- When diagnosing environment, toolchain, or third-party library failures, read `know-bugs.md` before changing the machine. Record there only known external bugs and constraints that cannot be fixed in this codebase; application defects belong in the issue tracker or application documentation.

## Repository map

- `apps/web` — React/TanStack client shared by web and Electron.
- `apps/desktop` — Electron main/preload code.
- `packages/desktop-native` — Windows native media/runtime implementation and vendored LiveKit client.
- `packages/api-types` — generated/shared API types.
- `packages/platform` — shared runtime and capability layer.
- `services/backend` — Rust backend and daemons.
- `services/livekit-server` — project LiveKit server fork.
- `deploy/production`, `deploy/nightly` — deployment sources of truth.

Root release version source: `VERSION`.

## Common commands

```sh
pnpm install
pnpm web:dev
pnpm web:test
pnpm web:build
pnpm desktop:dev
pnpm desktop:build
pnpm backend:check
pnpm livekit:check
```

On Windows, missing OpenSSL/vcpkg/Docker for backend checks is an environment blocker. Do not install or reconfigure that toolchain unless explicitly asked.

## Git and releases

- `develop` is nightly integration; `main` is production.
- Before non-trivial work, check the branch, remotes, linked PR/issue, and relevant existing issues.
- Issue branches should include the issue number when applicable.
- If asked to commit, push, and open a PR in one flow, use the `yeet` skill.
- Open completed PRs ready for review unless there is a concrete reason to use draft.
- Always distinguish local, committed, pushed, built, and deployed state.
- A `VERSION` change on `main` triggers release workflows.

## Client UI

- Do not hardcode UI colors or use Tailwind palette/arbitrary colors. Use semantic theme tokens such as `primary`, `destructive`, `chart-*`, `background`, `card`, and `border`.
- Theme sources of truth are `apps/web/src/features/appearance/theme-catalog-data.ts`, `theme-tokens.ts`, and `applyThemeToDocument()`. `styles.css` contains only non-color static tokens.
- API-provided role/server colors, role color selection, decorative avatar gradients, meta colors, and native window-shell colors are exceptions.
- `VITE_RELEASE_CHANNEL` is the only client release-channel source. Define experimental UI capabilities in `apps/web/src/lib/ui-feature-flags.ts` and gate every entry point; flags are not authorization boundaries.

## Deployment safety

- Production and nightly must keep independent data, secrets, storage, databases, queues, and LiveKit configuration.
- Nightly desktop must keep its own app ID, product name, protocol, data paths, endpoints, and release assets; do not enable nightly auto-update.
- Never expose or commit credentials. Do not overwrite server-local runtime files or perform destructive Docker/filesystem/database operations without explicit approval.
- Server-local `data/`, `.env*`, `secrets.env`, `Syrnike.toml`, `livekit.yml`, and `compose.override.yml` must survive repository syncs.
- Back up production compose before changing it and prefer scoped service restarts.
- Verify both production and nightly public endpoints after shared edge-routing changes.
