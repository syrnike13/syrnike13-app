# Windows native media v2 resource ownership

| Resource | Owner object | Owner thread | Created at | Destroyed at | Cancellation | May outlive session? |
| --- | --- | --- | --- | --- | --- | --- |
| `Engine` and desired state | Addon `AddonOwner` | Engine control thread mutates state | Utility addon load | Typed shutdown | Bounded command; utility kill on non-cooperation | No |
| Control mailbox/thread | `Engine::Implementation` | Engine control thread | Engine construction | Terminal `Stopped` | Capacity 16 with reserved shutdown/completion paths; never detached | No |
| Credential leases | Private Engine store | Engine control thread | `installCredentialLease` | Consumed by one connect attempt, replaced, or cleared on shutdown | Maximum four pending; token never enters public state | No; connection attempt only |
| Room reconciliation | Engine plus `RoomOwner` | Engine control thread plus one deadline watchdog | Accepted room intent | Room off or shutdown | Non-blocking completion, generation fencing, and independent connect/disconnect/cancellation deadlines | No |
| LiveKit `Room` | `LiveKitRoomTransport` | One persistent transport worker | Accepted intent with valid lease and matching Room/participant authority | Disconnect before shutdown | A missed operation deadline emits `room_operation_unresponsive`; the supervisor kills and replaces the compromised utility epoch | No |
| LiveKit lanes | `LiveKitRoomTransport` | One operation worker plus one cancellation worker | Addon construction | Addon destruction after clean Engine shutdown | One pending/running operation; cancellation never blocks Engine control; threads are never per-operation or detached | Yes; utility scoped |
| LiveKit global runtime | Utility process | SDK internal threads | First Room use | Utility exit | Utility process is the fault boundary | Yes; utility scoped |
| Public Node callback | `AddonOwner` | Native enqueue, utility JS drain | Registration | Addon cleanup | Buffer 64, one TSFN dispatch, state coalescing and snapshot recovery | No |
| Diagnostic callback | `AddonOwner` | Native enqueue, utility JS drain | Registration | Addon cleanup | Bounded non-blocking lane; telemetry may drop | No |
| Media utility process | `MediaRuntimeSupervisor` | Electron main owns lifecycle | First explicit start | App/session shutdown or unexpected exit | Fixed handshake/request/outer deadlines and two retries | It may span Room sessions |
| Request/promise | Supervisor pending map | Electron event loop | Typed command | Reply, timeout, exit, or shutdown | Capacity 16; every terminal path clears it | No |

The utility is deliberately app/session scoped, which avoids repeated SDK initialization and leaves a stable owner for the future warm microphone. Credentials and desired room state remain connection-epoch scoped, so a long-lived utility does not retain expired authority. Async Room callbacks capture weak shared mailbox/state objects rather than raw owners. A utility epoch with a non-returning SDK operation is never reused, because process replacement is the only safe way to reclaim that unknown native ownership.
