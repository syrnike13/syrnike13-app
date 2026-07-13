# Vendored LiveKit client SDK

This directory contains ordinary tracked source files, not Git submodules.

- `client-sdk-cpp`: https://github.com/livekit/client-sdk-cpp at `7596552cdba189fd908c8daa1b55c353efd015a3` (`v1.3.0`)
- `client-sdk-rust`: https://github.com/livekit/client-sdk-rust at `dad794d414fda9e8c1de83af1c0f190506a15f8f`
- `livekit-protocol/protocol`: https://github.com/livekit/protocol at `df0314e189f0ab695005c5edc10f087b5a36ad23`
- `yuv-sys/libyuv`: https://chromium.googlesource.com/libyuv/libyuv at `917276084a49be726c90292ff0a6b0a3d571a6af`

The upstream `LICENSE` and `NOTICE` files are retained at their original paths. To refresh the vendor tree, check out the exact revisions above, initialize the two nested Rust submodules, then copy tracked files while excluding every `.git` and `.gitmodules` entry.

## Local fork changes

The Syrnike fork adds the strict `WindowsD3D11Hardware` encoder selection contract and a public D3D11 shared-texture lease/source seam. A custom WebRTC `VideoEncoderFactory` drives hardware-only Media Foundation H.264 transforms with exact-adapter D3D11 NV12 input; unsupported adapters and asynchronous transforms fail closed. Software fallback is deliberately forbidden for every explicit backend request.

Windows builds require MSVC toolset 14.44 or newer because the pinned upstream WebRTC archive uses the corresponding standard-library ABI.
