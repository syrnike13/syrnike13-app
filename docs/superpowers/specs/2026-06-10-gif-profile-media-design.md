# GIF Profile Media Design

## Goal

Support uploaded GIF files as animated avatars and profile banners while keeping small UI surfaces lightweight.

## Behavior

- GIF uploads for `avatars` and `backgrounds` are allowed up to 10 MB.
- Other image formats keep the existing upload limits.
- Static preview URLs continue to render generated WebP previews.
- Animated avatar/banner display uses the original GIF only when the file is an animated GIF.
- Large profile surfaces animate immediately.
- Small avatar surfaces show static preview and load the original GIF only on hover or keyboard focus.
- Voice stage avatars animate only while the existing `speaking` prop is true.
- No user setting is added.

## Backend

- Autumn chooses the upload limit after MIME detection.
- `image/gif` files in `avatars` and `backgrounds` receive a 10 MB limit.
- Original GIF responses for `avatars` and `backgrounds` use `Content-Disposition: inline`.
- Other original file responses remain `attachment`.

## Frontend

- `apps/web/src/lib/media.ts` owns animated/static URL selection.
- `UserAvatar` gets an explicit animation mode: `never`, `hover`, `always`, or `speaking`.
- Existing small avatar uses default hover behavior.
- Large profile/card uses pass `always`.
- Voice stage passes `speaking` without additional debounce.

## Verification

- Web tests cover animated URL selection and hover/speaking avatar behavior.
- Backend tests cover GIF upload limit and original disposition policy.
- Run web tests/build and backend check when feasible.
