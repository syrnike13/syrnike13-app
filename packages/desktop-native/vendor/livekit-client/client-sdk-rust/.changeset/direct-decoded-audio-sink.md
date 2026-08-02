---
"webrtc-sys": patch
"libwebrtc": patch
"livekit-ffi": patch
---

Add a synchronous borrowed-PCM callback ABI for decoded audio tracks so native
renderers can consume WebRTC audio without the protobuf event queue.
