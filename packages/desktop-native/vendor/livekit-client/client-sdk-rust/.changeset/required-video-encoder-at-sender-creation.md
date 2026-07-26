---
"webrtc-sys": patch
"libwebrtc": patch
"livekit": patch
---

Attach required video encoder backends during sender creation and fail before
creating a transceiver when the backend is unavailable.
