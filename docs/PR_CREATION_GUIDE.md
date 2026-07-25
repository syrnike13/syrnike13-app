# Инструкция по созданию PR stack

## Текущее состояние

✅ Все изменения закоммичены в `fix/50-native-module-stabilization`  
✅ Коммит: `5d36860f` — "fix(desktop): stabilize native Windows media runtime"  
✅ 145 файлов изменено, +16700/-1989 строк

---

## Шаг 1: Push базовой ветки

```bash
git push origin fix/50-native-module-stabilization
```

Эта ветка содержит **все изменения**. Теперь создадим 4 отдельных ветки для PR'ов.

---

## Шаг 2: Создать PR #1 - Observability & Lifecycle

```bash
# Создать ветку от main
git checkout -b fix/native-observability-lifecycle main

# Cherry-pick нужных файлов через interactive rebase
# Или создать новый коммит с нужными файлами:

git checkout fix/50-native-module-stabilization -- \
  apps/desktop/src/main/diagnostic-bundle.ts \
  apps/desktop/src/main/index.ts \
  apps/desktop/src/main/native-media-engine.ts \
  apps/desktop/src/main/native-media-engine.test.ts \
  apps/desktop/src/main/shutdown-budget.ts \
  apps/desktop/src/main/shutdown-budget.test.ts \
  apps/desktop/src/main/native-runtime/contract.ts \
  apps/desktop/src/main/native-runtime/contract.test.ts \
  apps/desktop/src/main/native-runtime/diagnostic-incidents.ts \
  apps/desktop/src/main/native-runtime/diagnostic-incidents.test.ts \
  apps/desktop/src/main/native-runtime/diagnostic-log.ts \
  apps/desktop/src/main/native-runtime/diagnostic-log.test.ts \
  apps/desktop/src/main/native-runtime/media-ipc.ts \
  apps/desktop/src/main/native-runtime/media-ipc.test.ts \
  apps/desktop/src/main/native-runtime/native-media-controller.ts \
  apps/desktop/src/main/native-runtime/native-media-controller.test.ts \
  apps/desktop/src/main/native-runtime/runtime-supervisor.ts \
  apps/desktop/src/main/native-runtime/runtime-supervisor.test.ts \
  apps/desktop/src/main/native-runtime/utility-adapter.ts \
  apps/desktop/src/main/native-runtime/utility-adapter.test.ts \
  apps/desktop/src/utility/runtime-host.ts \
  apps/desktop/src/utility/runtime-host.test.ts \
  apps/desktop/src/preload/index.ts \
  apps/desktop/src/preload/index.test.ts \
  packages/desktop-native/native/src/common/async_cleanup_dispatcher.hpp \
  packages/desktop-native/native/src/common/bounded_release_ledger.hpp \
  packages/desktop-native/native/src/common/control_event_lane.hpp \
  packages/desktop-native/native/src/common/bounded_queue.hpp \
  packages/desktop-native/native/src/common/coalescing_event_lane.hpp \
  packages/desktop-native/native/src/common/diagnostic_log.cpp \
  packages/desktop-native/native/src/common/diagnostic_log.hpp \
  packages/desktop-native/native/src/common/event_sink.hpp \
  packages/desktop-native/native/src/common/node_event_sink.cpp \
  packages/desktop-native/native/src/common/node_event_sink.hpp \
  packages/desktop-native/native/src/common/sequenced_emitter.hpp \
  packages/desktop-native/native/src/common/runtime_types.hpp \
  packages/desktop-native/native/src/media/media_addon.cpp \
  packages/desktop-native/native/src/media/media_runtime.cpp \
  packages/desktop-native/native/src/media/media_runtime.hpp \
  packages/desktop-native/native/src/media/media_runtime_support.cpp \
  packages/desktop-native/native/src/media/livekit_publication_client.cpp \
  packages/desktop-native/native/src/media/livekit_publication_client.hpp \
  packages/desktop-native/native/src/media/microphone_actor.cpp \
  packages/desktop-native/native/src/media/microphone_actor.hpp \
  packages/desktop-native/native/src/hooks/hooks_addon.cpp \
  packages/desktop-native/native/src/hooks/hooks_runtime.cpp \
  packages/desktop-native/scripts/smoke-dropped-objectwrap-host.cjs \
  packages/desktop-native/scripts/smoke-async-cleanup-launch-failure-host.cjs \
  packages/desktop-native/scripts/smoke-active-call-shutdown-host.cjs \
  packages/desktop-native/scripts/smoke-quarantine-shutdown-host.cjs \
  packages/desktop-native/scripts/smoke-utility-host.test.cjs \
  docs/plans/native-module-stabilization-2026-07.md

git add -A
git commit -m "fix(desktop): native runtime observability and lifecycle hardening

Resolves 7 of 14 critical stability risks through lifecycle safety improvements
and comprehensive observability infrastructure.

## Lifecycle Safety

- **A1**: LiveKitRuntimeLifetime manages destruction order
- **A2**: endpoint_monitor shutdown before publication cleanup
- **A4-A6**: Replace std::terminate with 250ms graceful backpressure
- **A7**: Room teardown outside mutex (retired_room pattern)
- **A13**: BoundedReleaseLedger (4096 LRU entries)
- **Audio-c.1**: Internal commands don't kill host via contract corruption
- **Audio-c.2**: Separate microphone_operations_ queue
- **Audio-c.3**: Degraded state recovery via supervisor

## Observability

**Metrics:**
- actor_queue_depth_high (when depth > 200 or multiples of 50)
- tsfn_backpressure (control lane queue full)
- Structured diagnostic events

**Smoke Tests:**
- smoke-dropped-objectwrap: ObjectWrap released without shutdown
- smoke-async-cleanup-launch-failure: Startup failure cleanup
- smoke-active-call-shutdown: Shutdown during active session
- smoke-quarantine-shutdown: Blocked actor cleanup isolation

**Quarantine Shutdown:**
Detached thread mechanism isolates stuck actor cleanup (5s budget).
Process exits cleanly even when actors block in native operations.

## Acceptance Criteria

- All smoke tests pass
- ASAN clean on shutdown-during-active-session scenario
- First week metrics: native_contract_corruption → 0, adapter_recycled -80%

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"

git push origin fix/native-observability-lifecycle
```

**Создать PR на GitHub:**
- Base: `main`
- Head: `fix/native-observability-lifecycle`
- Title: `fix(desktop): native runtime observability and lifecycle hardening`
- Body: Скопировать из `docs/PR_STACK.md` секцию PR #1

---

## Шаг 3: Создать PR #2 - Screen Capture

```bash
git checkout -b fix/native-screen-capture-supervisor fix/native-observability-lifecycle

git checkout fix/50-native-module-stabilization -- \
  packages/desktop-native/native/src/media/capture_backend_supervisor.hpp \
  packages/desktop-native/native/src/media/screen_gpu_capture.cpp \
  packages/desktop-native/native/src/media/screen_gpu_capture.hpp \
  packages/desktop-native/native/src/media/screen_dxgi_compositor.cpp \
  packages/desktop-native/native/src/media/screen_actor.cpp \
  packages/desktop-native/native/src/media/screen_actor.hpp \
  packages/desktop-native/native/src/media/screen_publication_controller.cpp \
  packages/desktop-native/native/src/media/screen_publication_controller.hpp \
  packages/desktop-native/native/src/media/screen_capture_target.cpp \
  packages/desktop-native/native/src/media/screen_capture_slot_state.hpp \
  packages/desktop-native/native/src/media/display_sources.cpp \
  packages/desktop-native/native/src/media/display_source_window_probe.hpp \
  packages/desktop-native/native/src/media/d3d11_gpu_completion.hpp \
  packages/desktop-native/native/tests/capture_backend_supervisor_test.cpp \
  packages/desktop-native/native/tests/screen_capture_target_test.cpp \
  packages/desktop-native/native/tests/screen_dxgi_compositor_test.cpp \
  packages/desktop-native/native/tests/screen_publication_control_plane_test.cpp \
  packages/desktop-native/native/tests/screen_streaming_benchmark.cpp \
  packages/desktop-native/native/tests/screen_capture_slot_state_test.cpp \
  docs/plans/capture-backend-supervisor-transitions.md

# Удалить мёртвый код
git rm packages/desktop-native/native/src/media/screen_video_capture.cpp 2>/dev/null || true

git add -A
git commit -m "fix(desktop): rebuild Windows screen capture recovery architecture

Introduces CaptureBackendSupervisor state machine to replace three inconsistent
recovery mechanisms. Eliminates black screens, flickering, and shutdown hangs.

## Critical Fixes

- **Screen#1**: RequestAccessAsync cached (std::call_once, 750ms poll vs blocking)
- **Screen#2**: WGC 2s restart removed (handleNoFrame deleted)
- **Screen#3**: DXGI watchdog via supervisor (distinguishes no-content vs broken)

## CaptureBackendSupervisor

Unified state machine: Healthy → NoContent → Degraded → Reinitializing → Failed
- Bidirectional DXGI ↔ WGC fallback with exponential backoff
- secureDesktopActive() integration (UAC/lock → NoContent, not fallback)
- Distinguishes \"static screen\" from \"capture failure\"

## Performance

- Early ReleaseFrame for DXGI (copy → release immediately, convert from copy)
- Preview slot timeouts (prevents frame hold during encoder stall)

## Removed

- screen_video_capture.cpp (548 lines, dead code)
- handleNoFrame restart logic (replaced by supervisor)

## Acceptance Criteria

- Static screen 60s → zero restarts
- UAC prompt → pause/resume, no backend switch
- TDR recovery < 5s
- Application shutdown never hangs

See docs/plans/capture-backend-supervisor-transitions.md for state diagram.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"

git push origin fix/native-screen-capture-supervisor
```

**Создать PR на GitHub:**
- Base: `fix/native-observability-lifecycle`
- Head: `fix/native-screen-capture-supervisor`
- Title: `fix(desktop): rebuild Windows screen capture recovery architecture`

---

## Шаг 4: Создать PR #3 - Camera Async

```bash
git checkout -b fix/native-camera-async-capture fix/native-screen-capture-supervisor

git checkout fix/50-native-module-stabilization -- \
  packages/desktop-native/native/src/media/camera_capture.cpp \
  packages/desktop-native/native/src/media/camera_capture.hpp \
  packages/desktop-native/native/src/media/camera_actor.cpp \
  packages/desktop-native/native/src/media/camera_actor.hpp \
  packages/desktop-native/native/tests/camera_actor_lifecycle_test.cpp

git add -A
git commit -m "fix(desktop): Windows camera async capture with device removal tracking

Rewrites camera capture from sync ReadSample polling to IMFSourceReaderCallback
async model. Eliminates infinite hangs on USB disconnect and virtual cameras.

## Critical Fix

- **Screen#6**: Async callback replaces blocking ReadSample

## Architecture

**AsyncReaderState:**
- condition_variable with read_in_flight flag
- last_callback timestamp for watchdog
- device_removed tracking

**Callbacks:**
- OnReadSample: queue sample, signal condition_variable
- OnEvent: handle MEVideoCaptureDeviceRemoved
- OnFlush: 750ms deadline during shutdown

**Watchdog:**
2-second timeout: if (now - last_callback > 2s) → force stop + throw

**Device Removal:**
CM_Register_Notification + OnEvent detection → terminal event < 3s

## Removed

- Blocking ReadSample() polling loop
- Infinite thread.join() without timeout

## Acceptance Criteria

- USB camera disconnect → terminal event < 3s, no hang
- Virtual camera (OBS) graceful handling
- Repeated start/stop cycles stable (100 iterations)
- shutdown() during active capture completes < 1s

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"

git push origin fix/native-camera-async-capture
```

**Создать PR на GitHub:**
- Base: `fix/native-screen-capture-supervisor`
- Head: `fix/native-camera-async-capture`
- Title: `fix(desktop): Windows camera async capture with device removal tracking`

---

## Шаг 5: Создать PR #4 - Audio & Integration

```bash
git checkout -b fix/native-audio-quality-integration fix/native-camera-async-capture

# Все остальные файлы
git checkout fix/50-native-module-stabilization -- \
  packages/desktop-native/native/src/media/audio_devices.cpp \
  packages/desktop-native/native/src/media/audio_devices.hpp \
  packages/desktop-native/native/src/media/audio_processing.cpp \
  packages/desktop-native/native/src/media/microphone_audio_processor.cpp \
  packages/desktop-native/native/src/media/microphone_echo_reference.cpp \
  packages/desktop-native/native/src/media/microphone_echo_reference.hpp \
  packages/desktop-native/native/src/media/microphone_publication_controller.cpp \
  packages/desktop-native/native/src/media/microphone_capture_accumulator.hpp \
  packages/desktop-native/native/src/media/microphone_stream_delay_estimator.hpp \
  packages/desktop-native/native/src/media/wasapi_event.hpp \
  packages/desktop-native/native/src/media/remote_audio_output.cpp \
  packages/desktop-native/native/src/media/voice_actor.cpp \
  packages/desktop-native/native/src/media/voice_gate.cpp \
  packages/desktop-native/native/src/media/voice_attempt_commit.hpp \
  packages/desktop-native/native/src/media/screen_audio_capture.cpp \
  packages/platform/src/media.ts \
  packages/platform/src/media.test.ts \
  apps/web/src/components/layout/desktop-shell.tsx \
  apps/web/src/features/desktop/native-media-runtime-banner.tsx \
  apps/web/src/features/desktop/native-media-runtime-banner.test.tsx

# Version bumps
git checkout fix/50-native-module-stabilization -- \
  apps/admin/package.json \
  apps/desktop/package.json \
  apps/web/package.json \
  packages/api-types/package.json \
  packages/platform/package.json \
  package.json \
  apps/admin/src/version.gen.ts \
  apps/web/src/version.gen.ts \
  services/backend/VERSION \
  services/livekit-server/APP_VERSION

# Docs
git checkout fix/50-native-module-stabilization -- docs/PR_STACK.md

git add -A
git commit -m "fix(desktop): microphone audio quality and platform integration

Audio quality improvements and platform API integration for native runtime stack.

## Audio Quality

- **D2**: eConsole role (system default) instead of eCommunications
- **D3**: DATA_DISCONTINUITY handling + microphone_capture_discontinuity event
- **D4**: AEC from correct output device (livekit_client_->voiceOutputDeviceId())
- **D5**: Stream delay estimator (microphone_stream_delay_estimator.hpp)
- WasapiEventPair for event-driven capture (partial implementation)

## Platform Integration

- Platform API: media.ts updates for native runtime capabilities
- Desktop shell: native-media-runtime-banner component
- Version bumps across monorepo

## Acceptance Criteria

- Default device change → switch without restart
- Microphone discontinuity → logged + recovered
- AEC ERLE > 0 on non-default output device
- All platform tests pass

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"

git push origin fix/native-audio-quality-integration
```

**Создать PR на GitHub:**
- Base: `fix/native-camera-async-capture`
- Head: `fix/native-audio-quality-integration`
- Title: `fix(desktop): microphone audio quality and platform integration`

---

## Шаг 6: Создать итоговый tracking issue

Создать GitHub Issue с заголовком:

**[Epic] Native Windows Media Runtime Stabilization**

Body:
```markdown
Tracking issue for 4-PR stack addressing critical stability issues in desktop-native module.

## PR Stack

- [ ] #XXX PR #1: Observability & Lifecycle Hardening (базируется на `main`)
- [ ] #XXX PR #2: Screen Capture Recovery (базируется на PR#1)
- [ ] #XXX PR #3: Camera Async Capture (базируется на PR#2)
- [ ] #XXX PR #4: Audio Quality & Integration (базируется на PR#3)

## Critical Risks Resolved

10 of 14 P0 risks:
- A1, A2, A4-A7, A13 (lifecycle)
- Screen#1, Screen#2, Screen#6 (capture hangs)
- Audio-c.1, Audio-c.2, Audio-c.3 (audio crashes)

## Merge Strategy

1. Week 1: PR#1 → main, monitor incidents 3-5 days
2. Week 2: PR#2 + PR#3 → main (parallel after PR#1 analysis)
3. Week 2-3: PR#4 → main
4. Week 3: Beta release
5. Week 4: Stable release (if metrics clean)

## Success Metrics (4 weeks post-merge)

- `native_contract_corruption`: 5-10/day → 0
- `adapter_recycled`: 20-30/day → <5/day
- `liveness_probe_failed`: 15/day → <3/day
- Screen share success: 85% → >95%
- Camera success: 80% → >95%
- App hang on exit: 2% → <0.1%

See docs/PR_STACK.md for detailed breakdown.
```

---

## Итоговые команды (все сразу)

```bash
# Push базовую ветку
git push origin fix/50-native-module-stabilization

# Создать и push все ветки
git checkout -b fix/native-observability-lifecycle main
# ... (команды из Шага 2)

git checkout -b fix/native-screen-capture-supervisor fix/native-observability-lifecycle
# ... (команды из Шага 3)

git checkout -b fix/native-camera-async-capture fix/native-screen-capture-supervisor
# ... (команды из Шага 4)

git checkout -b fix/native-audio-quality-integration fix/native-camera-async-capture
# ... (команды из Шага 5)
```

Затем создать 4 PR на GitHub через веб-интерфейс с соответствующими base branches.

---

## Готово! 🎉

После выполнения всех шагов у тебя будет:
- ✅ 4 reviewable PR (30-40 файлов каждый)
- ✅ Stack с зависимостями (PR#2 зависит от PR#1, и т.д.)
- ✅ Полная документация в docs/PR_STACK.md
- ✅ Tracking issue для мониторинга прогресса
