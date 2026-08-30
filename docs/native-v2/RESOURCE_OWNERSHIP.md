# Windows native media v2 resource ownership

The lifecycle slice owns infrastructure resources only. It still owns no LiveKit, audio, capture, camera, graphics, or publication resource.

| Resource | Owner object | Owner thread | Created at | Destroyed at | Cancellation | May outlive session? |
| --- | --- | --- | --- | --- | --- | --- |
| `Engine` | Native addon `AddonOwner`; probe stack in `media_probe` | Constructed by utility/probe caller; state is mutated only by its control thread | Addon load or one probe cycle | Explicit `shutdown()` before addon/probe owner destruction | Shutdown command, 1 s core deadline; process termination on non-cooperation | No; one Engine is one lifecycle |
| Engine control thread | `Engine::Implementation` | The named C++ control thread | `Engine` construction | After terminal `Stopped` and completion of shutdown reply | Atomic shutdown signal plus bounded command/reply wait; never detached | No |
| Core lifecycle callback | `Engine` | Registered by addon/probe caller, invoked only by control thread | Before `start()` | Cleared immediately after terminal `Stopped` event | Registration closes at startup; shutdown joins the only producer | No |
| Public Node-API callback/reference | Native addon `AddonOwner` | Created/released on utility JavaScript thread; called from control thread through its public TSFN | `registerPublicEventCallback()` before handshake | After Engine shutdown during addon cleanup | Bounded queue of 64; overflow terminates the isolated utility because public state may not be dropped | No; addon dies with utility process |
| Diagnostic Node-API callback/reference | Native addon `AddonOwner` | Created/released on utility JavaScript thread; called from control thread through its diagnostic TSFN | `registerDiagnosticEventCallback()` before handshake | After Engine shutdown during addon cleanup | Non-blocking bounded queue of 64; overflow drops diagnostics only | No; addon dies with utility process |
| Accepted desired-state snapshot | C++ `Engine::Implementation` | Written and read only on the Engine control thread | First valid `applyDesiredState()` | Engine destruction after shutdown | Full validation precedes atomic replacement; revision rejects stale/conflicting writes | No |
| `windows_media.node` addon instance | Electron media utility process | Utility JavaScript thread | Verified utility-host startup | Utility clean exit or forced process termination | Host calls typed `shutdown()`; Electron main applies 1.5 s outer deadline | No |
| Electron media utility process | `MediaRuntimeSupervisor` | Electron main process | Explicit lifecycle start | Clean shutdown, unexpected exit, or outer kill | 5 s handshake; 1 s request; restarts after 250 ms and 1 s only | No |
| Control request/promise | `MediaRuntimeSupervisor.pending` until one reply/timeout | Electron main event loop | Any typed `handshake`, apply, query, ping, or shutdown request | Reply, request timeout, unexpected exit, or outer cleanup | Pending map capacity 16; every terminal path clears timer and entry; request ID only correlates the reply | No |
| In-flight apply commit guard | One C++ `Command` shared by caller and control queue | Caller may cancel; only control thread may commit | `applyDesiredState()` submission | Typed reply or deadline cancellation | Mutex chooses exactly one deadline/commit outcome; cancelled commands cannot replace accepted state | No |

## Rules

- One object owns creation and destruction; observers may borrow but cannot release or replace the resource.
- The owner thread and COM apartment are fixed before creation, and destruction runs on that thread unless the underlying API explicitly guarantees otherwise.
- Cancellation is idempotent, callbacks are fenced before dependent resources are destroyed, and every wait has a documented deadline and escalation path.
- A resource may outlive a voice session only when its lifetime is deliberately process-scoped and its reset semantics are tested.
- A timed-out non-cooperative native owner remains alive only until its utility process is terminated; it is never detached, quarantined, or transferred to a second owner.
