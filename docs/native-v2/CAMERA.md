# Independent camera pipeline (#129)

The camera has one asynchronous Media Foundation capture, one publication owner
and an optional preview worker. The native owners are usable independently of
microphone and screen. Client intent/UI integration belongs to #130.

On 2026-09-08 the user waived physical-camera and physical USB unplug/replug
checks because no physical camera was available, and requested simulation where
possible. Synthetic runs below are simulation evidence, not physical acceptance.
The installed Windows virtual Pixel 9 camera was tested through the real MF
adapter: 720p30 produced 93 frames over the start proof plus three seconds;
1080p30 returned `unsupported_profile` before `running`. Both paths stopped.

## Registry and capture

`CameraDeviceRegistry` owns at most 64 present endpoints and 256 lifetime opaque
identities. Identity uses the MF symbolic link, never only a display label.
Raw activation/COM objects do not escape the Windows adapter. Refresh projects
added, removed, availability and application-default changes. The application
default is the lowest available stable ID: Windows has no MMDevice-style default
video role. An explicit missing ID does not fall back to a different camera.
Notification callbacks coalesce changes into an atomic flag; the control owner
refreshes and reconciles. Device failure also arrives from the capture path.

Classification uses Windows metadata: a software source or `SWD` enumerator is
virtual; otherwise USB bus metadata identifies `physical_usb`, ACPI identifies
`integrated`, and insufficient metadata stays `unknown`. There is no vendor list.

The capture worker owns its MTA, MF startup, source, asynchronous Source Reader
and callback. Exactly one `ReadSample` may be outstanding. The callback takes one
sample reference, stamps receipt time, signals an event and returns. It does not
convert pixels or invoke publication/preview. The worker converts and releases
the sample before admitting a copied frame to the latest-frame port.

Requests support 1280×720@30 and 1920×1080@30. Negotiation checks native dimensions
and nominal frame rate, permits approximately 29.97 as 30, and verifies the
selected output dimensions/rate. A lower profile requires explicit
`allow_downgrade`; an unsupported exact request fails before `running`.
MF decodes MJPEG where its converters support it. Checked conversion handles
BGRA/RGB32, NV12 and YUY2, including packed bottom-up stride and explicit BT.601
or BT.709 YUV conversion. Buffer count, buffer length, row bounds, dimensions and
signed arithmetic are checked before access. Frames never exceed 1920×1080 BGRA.

Three fresh converted frames establish health. No-frame progress for two seconds
is terminal for that capture. Removal, source failure, changed format, malformed
samples and unsupported capability have separate typed failures.

## Ownership and bounds

| Resource | Owner | Bound and release |
| --- | --- | --- |
| Registry apartment, activation enumeration, notifications | Control-thread Windows adapter | 64 endpoints; unregister and release before apartment teardown |
| Native endpoint identity values | Registry and candidate | 256 historical IDs; no COM pointers |
| Source, Source Reader, callback | One capture worker | One active capture plus at most one candidate; finite flush and callback-destruction proof |
| Pending MF sample | Callback completion state, then capture worker | One reference; release after checked conversion, before fan-out |
| Conversion scratch and capture output | Each capture | One 8,294,400-byte scratch plus one fixed latest BGRA frame |
| Fan-out scratch | Pipeline worker | One 8,294,400-byte buffer; publication offered first |
| Publication and preview input ports | Pipeline | One fixed latest BGRA copy each; independent consumers |
| SDK source, track, participant references | CameraPublication via Room control lane | One published camera track; one sender; unpublish before releasing references |
| SDK input frame and copy scratch | Camera sender worker | At most one current 1080p BGRA frame and scratch; profile changes replace the frame |
| Preview scaling scratch | Preview worker | One fixed input scratch plus 640×360 BGRA scratch; released on joined stop |
| Preview textures, handles and queries | Preview state retained by exported leases | Two slots, 983,040 accounted bytes each; retained leases stay counted after stop |
| Optional GPU preview partition | Process atomic budget shared with screen preview | 8 MiB total; never borrows publication/remote receive reserves |

The frame ports preallocate one frame and use one `atomic_flag` try-operation on
both sides. Contention drops a frame; no producer waits for a consumer. A new
generation clears old pending data. Receipt age is preserved through all copies;
frames older than 150 ms are dropped, including immediately before SDK admission.
The sender serializes SDK calls, so a device/profile transition cannot submit new
then old generations. An SDK call already in flight finishes before the next
generation is submitted. No MF sample survives into SDK or renderer ownership.

Preview downsamples on its own worker and uploads to two shared BGRA textures.
It only tries the process D3D11 context mutex; it never waits for capture or
publication. GPU event queries are polled without a blocking GPU wait. No progress
for 500 ms quarantines that slot and reports `gpu_stalled`. Allocation pressure,
GPU failure and a consumer holding a keyed mutex have separate preview failures.
A consumer opens the NT handle, acquires key 0 and releases key 0 before releasing
the move-only lease. An unopened lease can also be returned. Held leases retain
their exact backing across generation changes and owner stop; the last lease
returns its reservation. A stalled consumer consumes at most the two slots.
Turning preview demand off also releases free textures without requiring the
preview owner or the shared capture to restart. Held leases remain counted.
If a consumer returns a lease while still owning its keyed mutex, or a GPU fence
cannot complete before the stop deadline, that allocation's global reservation
is conservatively quarantined until process restart. Recreating a preview cannot
reuse an unproven reservation and accumulate exported textures indefinitely.

## Lifecycle

```mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> Candidate: first publication or preview demand
  Candidate --> Active: three healthy frames + fan-out acknowledgement
  Candidate --> Idle: first start fails
  Active --> Switching: new device or profile
  Switching --> Active: candidate healthy, bind new, stop old
  Switching --> Active: candidate fails, retain old
  Active --> Active: preview toggles while publication remains
  Active --> Active: publication off while preview remains
  Active --> Idle: both demands off, bind null and close capture
  Active --> Failed: removal / no frames / source error
  Failed --> Candidate: explicit retry or changed device catalog
  Idle --> [*]: joined pipeline stop
```

```mermaid
sequenceDiagram
  participant C as Camera control
  participant A as Active capture
  participant N as Candidate capture
  participant F as Frame fan-out
  participant P as Camera publication
  participant V as Optional preview
  C->>N: open requested device/profile
  N-->>C: three fresh converted frames
  C->>F: bind candidate port and generation
  F-->>C: acknowledge generation boundary
  C->>A: retire, flush, join
  N->>F: bounded owned BGRA
  F->>P: latest frame first
  F->>V: separate lossy latest copy
  Note over P,V: independent owners and consumer lifetimes
```

```mermaid
stateDiagram-v2
  [*] --> Unpublished
  Unpublished --> Publishing: camera publication demand
  Publishing --> Published: Room lane publish + commit
  Publishing --> Unpublished: rollback and release partial resources
  Published --> Published: capture switch / preview change / camera failure
  Published --> Stopping: publication demand removed
  Stopping --> Unpublished: sender joined + Room lane unpublish acknowledged
```

Capture start has a four-second deadline. Stop retires output immediately, flushes
an outstanding asynchronous request with a two-second deadline, releases the
reader/source, verifies callback destruction and joins the worker. Source Reader
normally calls source shutdown on release; a subsequent `MF_E_SHUTDOWN` is already
closed, not a cleanup failure. This follows the documented
[Source Reader shutdown ownership](https://learn.microsoft.com/en-us/windows/win32/medfound/mf-source-reader-disconnect-mediasource-on-shutdown)
and [asynchronous flush completion](https://learn.microsoft.com/en-us/windows/win32/api/mfreadwrite/nf-mfreadwrite-imfsourcereader-flush).

The outer utility-process kill boundary remains necessary for a driver that
blocks inside a Windows call. Owners never detach an unjoined worker or pretend
that a deadline proves resource destruction. Failed finite cleanup returns a
typed timeout; destruction without completed cleanup terminates the disposable
process. Camera errors do not call Room reconnect or microphone/screen controls.

## Verification

`camera_tests` covers format bounds, color conversion, latest-frame contention,
age/generation rejection, registry identity, failed/healthy candidates, 100
preview toggles, preview-only and no-demand behavior, delayed conversion, pending
sample cancellation, late callbacks and typed loss. Its test-only asynchronous
reader has a separate callback thread and counts live readers and samples.
`camera-preview` (`camera_tests --preview`) imports the real GPU texture and checks its pixels,
holds both slots, switches generations, stops with a live lease and competes
with screen preview for the shared budget. It carries `requires-gpu-video` for
the known hosted-runner hardware boundary. The existing screen preview regression
test also passes with the shared budget.

## Product profile policy

Voice credentials include `camera_profiles`, computed by the backend from the
account's video entitlement, channel Video permission, pixel-area cap and aspect
range. Native profiles are `hd720p30` and `hd1080p30`; the desktop adapter does
not start capture for a profile absent from that credential. The camera path
reports `camera_profile_not_permitted` while the Room and other media paths stay
active. Selecting an allowed profile applies the retained camera intent without
a new Room join. Refresh and channel moves carry the destination policy.

A device can also reject an allowed profile. The camera transaction retains the
previous healthy capture in that case, and the product banner explicitly reports
that the requested settings were not applied. It does not silently choose a
different profile.
