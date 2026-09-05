# Production GPU screen pipeline

Issue #121 adds a separate production screen path. The CPU reference remains a
lab oracle and is never selected as a fallback.

## Data path and ownership

```text
WGC FrameLease (BGRA D3D11 texture)
  -> ScreenFramePipeline, one latest-wins pending lease
  -> GpuScreenConverter, three fixed NV12 D3D11 textures
  -> HardwareH264Encoder, one latest-wins input and three fixed bitstream slots
  -> ProductionScreenSender, one active plus one ordered pending access unit
  -> LiveKitScreenPublicationAdapter on LiveKitRoomTransport's SDK lane
  -> EncodedVideoSource / strict PreEncoded backend
```

`D3d11DeviceOwner` is process-scoped and exposes its adapter LUID. WGC,
VideoProcessor conversion, and Media Foundation therefore use the same D3D11
device. Conversion submits a BGRA-to-NV12 VideoProcessor blit with BT.709 studio
range and never maps, flushes, or waits on a GPU fence. The encoder wraps the
NV12 texture in an `IMFDXGISurfaceBuffer`; the only per-frame CPU copy is the
compressed H.264 access unit into a preallocated output slot.

The encoder enumerates only `MFT_ENUM_FLAG_HARDWARE` H.264 transforms. Startup
fully configures the D3D manager, NV12 input, H.264 output, low latency, CBR,
zero B-frames, and the selected profile before publication starts. Failure is
typed and terminal; software H.264 is never queried.

The SDK pass-through advertises a trusted rate controller so WebRTC does not
drop dependent access units after encoding. Its offer starts near the declared
fixed bitrate instead of the ordinary 1 Mbps raw-encoder ceiling; otherwise the
RTP pacer accumulates seconds of video that the external encoder cannot resize
or re-encode in response to startup bandwidth estimates.

## Fixed profiles and memory

| Profile | Nominal capture pool (3× BGRA) | NV12 pool (3 slots) | Encoded pool (3×2 MiB) | Nominal total |
|---|---:|---:|---:|---:|
| 1920×1080 @ 60, 8 Mbps | 24,883,200 B | 9,331,200 B | 6,291,456 B | 40,505,856 B |
| 2560×1440 @ 30, 10 Mbps | 44,236,800 B | 16,588,800 B | 6,291,456 B | 67,117,056 B |
| 1280×720 @ 30, 4 Mbps | 11,059,200 B | 4,147,200 B | 6,291,456 B | 21,497,856 B |

The capture column is nominal because its textures follow source dimensions.
The lab explicitly enables a source-sized BGRA marker texture and paints its
288×72 box. Production defaults neither allocate that texture nor paint the
marker, and require only one VideoProcessor input stream. Converter and bitstream pools never
grow. A size change cannot replace converter textures while a slot lease is
active, so a generation is retired only after all of its leases return.

## Backpressure, controls, and stop

Capture and encoder inputs keep the newest frame, because screen video is lossy
and age matters more than continuity before encoding. Encoded H.264 access units
retain their order: occupied output slots plus accepted inputs cannot exceed
three, and a full publication queue rejects admission without taking ownership.
Backpressure therefore reaches raw input before any reference frame is lost.
Publication control, key-frame requests,
unpublish acknowledgements, and slot releases are lossless. PLI/FIR is polled
from the pre-encoded LiveKit source and forwarded to
`CODECAPI_AVEncVideoForceKeyFrame`. The selected profile keeps a fixed bitrate,
FPS, and resolution for its entire publication.

Stop revokes capture acceptance, joins the pipeline worker, drains the encoder,
unpublishes the screen track, and waits for every submitted encoded slot. A
publish, submit, drain, or unpublish timeout is reported with its stage. If a
native/SDK call still borrows memory, stop requires media utility epoch
retirement, while Voice Membership and Room ownership stay outside this module.
The worker completion signal follows COM/MF cleanup. Stop waits for that signal
within its deadline before joining; destruction of an unretired hung worker
terminates the isolated utility process instead of detaching it. An encoder
failure immediately fails the pipeline and initiates track unpublication.

## Verification

`gpu_screen_converter_tests` runs on the real Windows adapter and verifies all
three strict hardware capabilities, BT.709 GPU conversion, fixed-pool
exhaustion/reuse, a real NV12-to-H.264 output, encoder drain, and the integrated
production lifecycle. `production_screen_sender_tests` injects overload and
hung SDK operations to prove encoded reference preservation, independent deadlines, late
slot return, and unpublish escalation.
`encoder_fault_tests` injects an encoder failure and blocks MFShutdown to verify
failure propagation and the cleanup deadline. The GPU tests also hold all three
encoded slots and verify that only pending raw input is superseded.

The LiveKit fork and application were built locally and exercised through a
neutral `@livekit/rtc-node` observer. The measured 1080p60 monitor run decoded
417 frames with 132 ms p95 latency, the 1080p60 window run decoded 419 frames
with 60 ms p95 latency, the 1440p30 run decoded 209 frames with 186 ms p95
latency, and 30 720p30 publish/unpublish cycles delivered 900 measured frames
with 56 ms p95 latency. All runs had zero stale or out-of-order frames and no
encoder output stall. The application keeps using the pinned `.2`
SDK bundle until the fork changes are reviewed, released, and deliberately
pinned; local validation uses `MEDIA_LAB_LIVEKIT_SDK_ROOT` and does not alter the
release dependency.
