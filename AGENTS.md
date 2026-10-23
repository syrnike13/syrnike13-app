# Repository guide

## Working rules

- Use `pnpm` and prefer the narrowest command for the affected package or service.
- Search with `rg`/`rg --files`; never search inside `node_modules`.
- Preserve unrelated user changes in a dirty worktree. Use `apply_patch` for manual edits and avoid destructive Git commands.
- Prefer small, explicit, production-friendly APIs. Do not add compatibility paths or wrappers unless requested.
- Do not create issues, branches, PRs, comments, deployments, or external side effects unless requested.
- For manual-save UI, register dirty state with the shared draft controller and show `UnsavedChangesBar` with save and reset actions.
- When diagnosing environment, toolchain, or third-party library failures, read `know-bugs.md` before changing the machine. Record there only known external bugs and constraints that cannot be fixed in this codebase; application defects belong in the issue tracker or application documentation.

## Repository map

- `apps/web` — React/TanStack client shared by web and Electron.
- `apps/landing` — отдельный Vite-лендинг на `syrnike13.ru`.
- `apps/desktop` — Electron main/preload code.
- `packages/desktop-native` — Windows global input and foreground-window hooks addon.
- `packages/windows-media-engine` — Windows native media engine (`windows_media.node`): voice, screen, camera, remote media.
- `packages/api-types` — generated/shared API types.
- `packages/platform` — shared runtime and capability layer.
- `services/backend` — Rust backend and daemons.
- `services/livekit-server` — project LiveKit server fork.
- `deploy/production`, `deploy/nightly` — deployment sources of truth.

The root `VERSION` file is the base version for local builds. Production takes its release version from the manual dispatch form, and nightly builds derive `<YYYY.M.D>-nightly.<sha>` without reading the file.

## Common commands

```sh
pnpm install
pnpm web:dev
pnpm landing:dev
pnpm web:test
pnpm web:build
pnpm lint:design
pnpm desktop:dev
pnpm desktop:build
pnpm backend:check
pnpm livekit:check
```

On Windows, missing OpenSSL/vcpkg/Docker for backend checks is an environment blocker. Do not install or reconfigure that toolchain unless explicitly asked.

## Git and releases

- `develop` is nightly integration; `main` is production.
- Issue branches should include the issue number when applicable.
- Open completed PRs ready for review unless there is a concrete reason to use draft.
- Always distinguish local, committed, pushed, built, and deployed state.
- `VERSION` changes and pushes to `main`/`develop` no longer start release workflows; production and nightly releases are manual `workflow_dispatch` runs.

### Pull requests

Every PR is written for a reviewer who did not watch the work happen. Fill `.github/PULL_REQUEST_TEMPLATE.md` in full.

- Title uses Conventional Commits in English, matching the commit history. Body is Russian prose; keep code, commands, paths, identifiers, and quoted errors verbatim.
- Start with a `TL;DR` of 1–4 plain-language bullets: what changed and why it matters. It is not a diff recap.
- Show, do not explain. UI changes get before/after screenshots or a short clip captured from this branch's build. Performance and resource changes get before/after numbers with method, hardware, and build configuration. Behaviour, protocol, schema, and diagnostic changes get the exact observable difference. When an honest "before" is unavailable, show only "after" and say why; never reconstruct or stage "before" evidence.
- Drop sections that do not apply instead of inventing content or leaving placeholders.
- Before opening, fetch and refresh the branch onto the current base (`develop` unless the PR is stacked). Open only an up-to-date, conflict-free PR. If the base moves while the PR is open, refresh the branch and re-run the affected checks.
- Run the checks for what changed (`pnpm check:ui`, `pnpm check:messages`, affected typecheck/test/build, `pnpm backend:check`, `pnpm livekit:check`) and list the exact commands and results. State what was not run or verified, and never claim CI passed before it finishes.
- One logical change per PR. Unrelated fixes become follow-ups, not drive-by edits.
- Update the body when the diff changes materially. Keep secrets, tokens, and personal data out of screenshots, logs, and pasted output.

## Client UI

- Full UI rules, component catalog, reference screens and desktop contracts live in `packages/ui/AGENTS.md`. Read it before UI work; run `pnpm check:ui` and `pnpm lint:design` before finishing.
- Target UI metrics (type, spacing, element sizes, current gaps) live in `docs/client-metrics-reference.md`. Align sizes and geometry; do not reuse proprietary font files.
- Build screens from `@syrnike13/ui/primitives/*`. Primitives are literal shadcn/ui `base-nova` sources on Base UI; do not create local copies or lookalikes. Use the `render` prop instead of Radix `asChild`.
- Sliders in settings (and new sliders with stops or labels) use `PresetSlider` from `apps/web/src/components/ui/preset-slider.tsx`; the raw `Slider` primitive is its low-level base and is not imported on settings surfaces. `pnpm check:ui` enforces this; `showLabels={false} showMarks={false}` gives the plain slider look.
- Do not hardcode UI colors or use Tailwind palette/arbitrary colors. Use semantic theme tokens such as `primary`, `destructive`, `chart-*`, `background`, `card`, and `border`.
- Theme sources of truth are `packages/ui/src/tokens` (being migrated from `apps/web/src/features/appearance/theme-catalog-data.ts`, `theme-tokens.ts`, and `applyThemeToDocument()`). `styles.css` contains only non-color static tokens.
- All UI strings, including `aria-label`, `placeholder`, and `title`, go through `useTranslations` from `@syrnike13/ui/i18n`; catalogs are `apps/{web,landing,admin}/src/messages/{en,ru}.json`.
- API-provided role/server colors, role color selection, decorative avatar gradients, meta colors, and native window-shell colors are exceptions.
- `VITE_RELEASE_CHANNEL` is the only client release-channel source. Define experimental UI capabilities in `apps/web/src/lib/ui-feature-flags.ts` and gate every entry point; flags are not authorization boundaries.

## Deployment safety

- Production and nightly must keep independent data, secrets, storage, databases, queues, and LiveKit configuration.
- Nightly desktop must keep its own app ID, product name, protocol, data paths, endpoints, and release assets; do not enable nightly auto-update.
- Never expose or commit credentials. Do not overwrite server-local runtime files or perform destructive Docker/filesystem/database operations without explicit approval.
- Server-local `data/`, `.env*`, `secrets.env`, `Syrnike.toml`, `livekit.yml`, and `compose.override.yml` must survive repository syncs.
- Back up production compose before changing it and prefer scoped service restarts.
- Verify both production and nightly public endpoints after shared edge-routing changes.
