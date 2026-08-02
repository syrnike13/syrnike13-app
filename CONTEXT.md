# Domain context

This file defines shared terms and architectural invariants. Detailed decisions belong in ADRs and implementation plans.

## Voice ownership

- **Voice Intent** is the channel the user currently wants to occupy, or none after an explicit leave. Newer intent supersedes unfinished work.
- **Voice Director** exclusively owns Voice Intent, operation recency, membership transitions, recovery policy, and the public voice snapshot. It never captures, publishes, decodes, or renders media.
- **Voice Operation** identifies one join, move, recovery, or leave transaction and may only be created or superseded by the Voice Director.
- **Voice Session** reconciles one Voice Intent with backend membership and independent media tracks. On desktop it survives renderer reload, but not full application restart or Windows sleep.
- **Client Instance** identifies one owner tab or desktop main process. One account may have only one active instance in voice.

## Authority and transport

- **Voice Reservation** binds a user, channel, RTC engine, Voice Operation, Client Instance, and Connection Epoch before connection.
- **Voice Membership** is committed by the backend only after observing the matching signed LiveKit participant. Track readiness is not membership.
- **Connection Epoch** identifies one physical RTC connection attempt. Recovery creates a new epoch.
- **RTC Engine** is one LiveKit Room/participant, implemented by the browser adapter or Windows native adapter.
- An **Authoritative Voice Snapshot** replaces membership state atomically by revision. Missing partial data is never evidence of leave.

## Media

- Microphone, camera, screen video, and screen audio are independent **Media Tracks** inside the RTC Engine. A track failure must not change Voice Membership.
- The **Screen Frame Pipeline** is bounded and latest-wins. Capture, GPU conversion, encoding, decode, and rendering may drop or supersede stale frames instead of growing latency.
- Frame data is lossy; control operations, keyframe intent, publication ownership, and resource release remain ordered and lossless.
- Local preview is an optional lossy projection and must never block or restart publication.
- The **Microphone Pipeline** is one warm capture/DSP path shared by publication, meter preview, and voice activity detection.
- **Media Demand** controls remote video subscription and decode. Remote audio remains subscribed.
- **User Mute** is the stored button choice. **Effective Mute** additionally includes deafen, administrative restrictions, lock-screen privacy, and push-to-talk; muting keeps capture and publication alive.

## Failure and recovery

- **Media Failure** is scoped to one track, capture device, decoder, renderer, or output path and does not initiate Voice Recovery by itself.
- Recovery acts on the smallest failed layer: presentation generation, local bridge, subscription, capture backend, track, then runtime. A frame timeout alone is never proof that a wider layer failed.
- **Voice Recovery** restores committed membership after terminal RTC/runtime loss while preserving Voice Intent and creating a new Connection Epoch.
- **Runtime Loss** is termination or unresponsiveness of one Windows utility host. Media, hotkey, and overlay hosts recover independently.
- `NativeRuntimeSupervisor` exclusively owns utility startup, handshake, crash classification, restart backoff, host epoch, and circuit state.
- The **Native Event Lane** has three classes: ordered control, bounded latest-per-resource media, and lossy telemetry. Dropped media releases retained native resources exactly once.
- A **Diagnostic Incident** is one typed causal failure with bounded sanitized evidence; related events enrich the same incident instead of creating competing reports.

## Channel activities and authorization

- A **Channel Activity** is a first-party app scoped to one voice channel. The backend owns its instance, participant set, revision, expiry, and state.
- The embedded activity runs in a sandboxed iframe, receives no session token or desktop preload API, and sends bounded commands through the trusted host.
- The backend produces revisioned **Effective Permissions** by authorization scope. Only the client authorization module converts them into named UI capabilities.
- Permission editing uses hypothetical drafts; drafts never authorize current-account actions.
