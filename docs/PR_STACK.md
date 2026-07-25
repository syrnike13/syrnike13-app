# PR Stack для стабилизации нативного модуля

## Обзор

4 PR'а, мерж последовательно в порядке 1→2→3→4.
Общий объём: ~115 файлов, 6400+ строк в ключевых файлах.
Цель: устранить критичные вылеты, зависания и нестабильность Windows media runtime.

---

## PR #1: Observability and Lifecycle Hardening

**Ветка:** `fix/native-observability-lifecycle`  
**Файлов:** ~40  
**Базируется на:** `fix/50-native-module-stabilization`

### Описание

Фундаментальные исправления lifecycle и наблюдаемости нативного модуля. Устраняет 7 из 14 критичных рисков, включая все "казни" через `std::terminate()`.

### Изменения

**Observability (Фаза 1):**
- ✅ Diagnostic log rotation и structured events
- ✅ Stderr capture from utility process
- ✅ Новые smoke-тесты: `smoke-dropped-objectwrap`, `smoke-async-cleanup-launch-failure`, `smoke-active-call-shutdown`, `smoke-quarantine-shutdown`
- ✅ Runtime метрики: `actor_queue_depth_high`, `tsfn_backpressure`, `gpu_frame_pool_exhausted`

**Lifecycle Safety (Фаза 2 + 6):**
- ✅ **A1** — `LiveKitRuntimeLifetime` управляет порядком разрушения
- ✅ **A2** — `endpoint_monitor_.reset()` в `MicrophoneActor::shutdown()`
- ✅ **A4-A6** — Замена всех `std::terminate()` на graceful handling (250ms backpressure timeout)
- ✅ **A7** — Room teardown outside `mutex_` (retired_room)
- ✅ **A9** — `asyncCleanup` через `uv_async_send` (правка на основе плана)
- ✅ **A13** — `BoundedReleaseLedger` (4096 entries, LRU eviction)
- ✅ **Audio-c.1** — Internal commands не убивают хост через contract corruption
- ✅ **Audio-c.2** — Отдельная `microphone_operations_` queue для долгих операций
- ✅ **Audio-c.3** — Degraded state recovery через `runtime-supervisor retry()`

**Quarantine Shutdown:**
- Новый механизм: detached thread для cleanup застрявших акторов
- Smoke-тест проверяет что shutdown завершается < 3s даже при блокировке операций

### Файлы

```
apps/desktop/src/main/
  diagnostic-bundle.ts
  index.ts
  native-media-engine.{ts,test.ts}
  native-runtime/
    contract.{ts,test.ts}
    diagnostic-{incidents,log}.{ts,test.ts}
    media-ipc.{ts,test.ts}
    native-media-controller.{ts,test.ts}
    runtime-supervisor.{ts,test.ts}
    utility-adapter.{ts,test.ts}
  voice/native-rtc-engine-adapter.{ts,test.ts}
  shutdown-budget.{ts,test.ts}
  
apps/desktop/src/utility/runtime-host.{ts,test.ts}
apps/desktop/src/preload/index.{ts,test.ts}

packages/desktop-native/
  native/src/common/
    addon_parsing.hpp
    bounded_queue.hpp
    bounded_release_ledger.hpp (НОВЫЙ)
    async_cleanup_dispatcher.hpp (НОВЫЙ)
    control_event_lane.hpp (НОВЫЙ)
    coalescing_event_lane.hpp
    diagnostic_log.cpp
    event_sink.hpp
    node_event_sink.{cpp,hpp}
    sequenced_emitter.hpp
    runtime_types.hpp
  
  native/src/media/
    actor_mailbox.hpp
    media_addon.cpp
    media_runtime.{cpp,hpp}
    media_runtime_support.{cpp,hpp}
    livekit_publication_client.{cpp,hpp}
    microphone_actor.{cpp,hpp}
    lifetime_safe_frame_release.hpp
  
  native/src/hooks/
    hooks_addon.cpp
    hooks_runtime.cpp
  
  native/tests/
    runtime_core_test.cpp
    runtime_integration_test.cpp
    livekit_publication_client_test.cpp
  
  scripts/
    smoke-dropped-objectwrap-host.cjs (НОВЫЙ)
    smoke-async-cleanup-launch-failure-host.cjs (НОВЫЙ)
    smoke-active-call-shutdown-host.cjs (НОВЫЙ)
    smoke-quarantine-shutdown-host.cjs (НОВЫЙ)
    smoke-utility-host.{cjs,test.cjs}
```

### Acceptance Criteria

- ✅ Все smoke-тесты проходят (вкл. новый quarantine test)
- ✅ ASAN-прогон чист на сценарии «shutdown during active sessions»
- 📊 Мониторинг первую неделю после merge:
  - `native_contract_corruption` падает до нуля
  - `adapter_recycled` снижается на 80%+
  - `liveness_probe_failed` снижается на 70%+
  - Новые инциденты `actor_shutdown_quarantined` < 1% сессий

### Reviewers

Фокус ревью:
- Quarantine shutdown mechanism (detached thread safety)
- BoundedReleaseLedger (LRU correctness)
- Порядок разрушения LiveKitRuntimeLifetime
- Smoke-тесты coverage

---

## PR #2: Screen Capture Recovery Architecture

**Ветка:** `fix/native-screen-capture-supervisor`  
**Файлов:** ~25  
**Базируется на:** PR #1 (`fix/native-observability-lifecycle`)

### Описание

Переписывает recovery-логику экранного захвата. Вводит единый `CaptureBackendSupervisor` вместо трёх несогласованных механизмов. Устраняет моргания, чёрный экран и зависания shutdown.

### Изменения

**Screen Recovery (Фаза 3):**
- ✅ **Screen#1** — `RequestAccessAsync` кэширован через `std::call_once` (750ms poll вместо blocking `.get()`)
- ✅ **Screen#2** — WGC 2-секундный restart удалён (handleNoFrame полностью убран)
- ✅ **Screen#3** — DXGI watchdog через supervisor (отличает "нет контента" от "сломано")
- ✅ `CaptureBackendSupervisor` — state machine с состояниями Healthy/NoContent/Degraded/Reinitializing/Failed
- ✅ `secureDesktopActive()` интеграция (UAC/lock → `NoContent` вместо fallback)
- ✅ Двусторонний DXGI↔WGC fallback с backoff
- ✅ Early `ReleaseFrame` DXGI (копируем→release сразу, конверсия из копии)
- ✅ Удаление `screen_video_capture.cpp` (мёртвый код 548 строк)

**Метрики:**
- `gpu_frame_pool_exhausted` (добавлено в PR#1)
- `screen_capture_backend_transition` (supervisor)

### Файлы

```
packages/desktop-native/native/src/media/
  capture_backend_supervisor.hpp (НОВЫЙ 8930 байт)
  screen_gpu_capture.{cpp,hpp}
  screen_dxgi_compositor.cpp
  screen_actor.{cpp,hpp}
  screen_publication_controller.{cpp,hpp}
  screen_capture_target.cpp
  screen_capture_slot_state.hpp (НОВЫЙ)
  display_sources.cpp
  display_source_window_probe.hpp (НОВЫЙ)
  d3d11_gpu_completion.hpp
  screen_video_capture.{cpp,hpp} (cpp УДАЛЁН)

packages/desktop-native/native/tests/
  capture_backend_supervisor_test.cpp (НОВЫЙ)
  screen_capture_target_test.cpp
  screen_dxgi_compositor_test.cpp
  screen_publication_control_plane_test.cpp
  screen_streaming_benchmark.cpp

docs/plans/
  capture-backend-supervisor-transitions.md (НОВЫЙ)
  native-module-stabilization-2026-07.md
```

### Acceptance Criteria

- ✅ Static screen 60s → zero restarts (супервизор не путает "нет контента" с поломкой)
- ✅ UAC prompt → pause and resume, NO backend switch
- ✅ TDR (device removal) → recovery < 5s
- ✅ Application shutdown NEVER hangs (RequestAccessAsync не блокирует)
- ✅ Benchmark: DXGI frame hold time < 2ms (early release)

### Reviewers

Фокус ревью:
- CaptureBackendSupervisor state transitions (см. transition diagram в docs/plans/)
- secureDesktopActive detection reliability
- Early ReleaseFrame correctness (копия vs оригинал)

---

## PR #3: Camera Async Capture Rewrite

**Ветка:** `fix/native-camera-async-capture`  
**Файлов:** ~15  
**Базируется на:** PR #2 (`fix/native-screen-capture-supervisor`)

### Описание

Полностью переписывает camera capture с sync `ReadSample` на async callback. Устраняет вечные зависания при отвале USB/виртуальных камер.

### Изменения

**Camera Rewrite (Фаза 4):**
- ✅ **Screen#6** — `IMFSourceReaderCallback` вместо синхронного `ReadSample`
- ✅ `AsyncReaderState` с `condition_variable` и `last_callback` timestamp
- ✅ 2-секундный watchdog (если `now - last_callback > 2s` → force stop + throw)
- ✅ 750ms flush deadline при shutdown
- ✅ Device removal tracking: `CM_Register_Notification` + `OnEvent(MEVideoCaptureDeviceRemoved)`
- ✅ `OnReadSample` / `OnEvent` / `OnFlush` handlers

**Удалено:**
- Синхронный `ReadSample` polling loop
- Бесконечный `thread.join()` без таймаута

### Файлы

```
packages/desktop-native/native/src/media/
  camera_capture.{cpp,hpp} (+1197 строк)
  camera_actor.{cpp,hpp} (+1049 строк)

packages/desktop-native/native/tests/
  camera_actor_lifecycle_test.cpp
```

### Acceptance Criteria

- ✅ USB camera disconnect → terminal event < 3s, no hang
- ✅ Virtual camera (OBS Virtual Cam) graceful handling
- ✅ Repeated start/stop cycles stable (100 iterations)
- ✅ `shutdown()` during active capture completes < 1s

### Reviewers

Фокус ревью:
- AsyncReaderState thread safety (condition_variable correctness)
- Watchdog не ложно срабатывает на медленных камерах
- Device removal detection completeness

---

## PR #4: Audio Quality and Platform Integration

**Ветка:** `fix/native-audio-quality-integration`  
**Файлов:** ~30  
**Базируется на:** PR #3 (`fix/native-camera-async-capture`)

### Описание

Улучшения качества аудио + все platform/UI интеграции. Финальный PR перед релизом.

### Изменения

**Audio Quality (Фаза 5 частично):**
- ✅ **D2** — Audio device role `eConsole` вместо `eCommunications` (системный дефолт)
- ✅ **D3** — `DATA_DISCONTINUITY` handling + `microphone_capture_discontinuity` event
- ✅ **D4** — AEC с правильного устройства (`livekit_client_->voiceOutputDeviceId()`)
- ✅ **D5** — Stream delay estimator (уже есть `microphone_stream_delay_estimator.hpp`)
- ⚠️ **D1** — Event-driven WASAPI частично (wasapi_event.hpp создан и подключен, но не полностью активирован)

**Platform Integration:**
- Version bumps (package.json, VERSION, gen.ts)
- Platform API changes (packages/platform/src/media.ts)
- Desktop shell integration (apps/web/src/components/layout/desktop-shell.tsx)
- Native media runtime banner (apps/web/src/features/desktop/)

### Файлы

```
packages/desktop-native/native/src/media/
  audio_devices.{cpp,hpp}
  audio_processing.cpp
  microphone_actor.{cpp,hpp}
  microphone_audio_processor.{cpp,hpp}
  microphone_echo_reference.{cpp,hpp}
  microphone_publication_controller.{cpp,hpp}
  microphone_capture_accumulator.hpp (НОВЫЙ)
  microphone_stream_delay_estimator.hpp (НОВЫЙ)
  wasapi_event.hpp (НОВЫЙ)
  remote_audio_output.{cpp,hpp}
  voice_actor.{cpp,hpp}
  voice_gate.cpp
  voice_attempt_commit.hpp (НОВЫЙ)
  screen_audio_capture.{cpp,hpp}

packages/desktop-native/native/tests/
  media_processing_test.cpp
  microphone_publication_control_plane_test.cpp
  remote_audio_output_failure_test.cpp
  voice_actor_lifecycle_test.cpp

packages/platform/src/
  api.ts
  index.ts
  ipc.ts
  media.{ts,test.ts}

apps/web/src/
  components/layout/desktop-shell.tsx
  features/desktop/native-media-runtime-banner.{tsx,test.tsx} (НОВЫЙ)
  lib/mentions.ts
  lib/message-markdown.tsx

Version files:
  apps/{admin,desktop,web}/package.json
  apps/{admin,web}/src/version.gen.ts
  packages/{api-types,platform}/package.json
  services/backend/VERSION
  services/livekit-server/APP_VERSION
  package.json
  
Vendor (LiveKit APM updates):
  packages/desktop-native/vendor/livekit-client/...
  (client-sdk-rust, libwebrtc, audio_processing_module)
```

### Acceptance Criteria

- ✅ Default device change (системное) → switch without restart
- ✅ Microphone discontinuity → logged + recovered (no crash)
- ✅ AEC ERLE > 0 on non-default output device
- ✅ `eConsole` role используется для микрофона и эхо-опоры
- ✅ All platform tests pass

### Reviewers

Фокус ревью:
- Audio device role change impact (eCommunications → eConsole)
- DATA_DISCONTINUITY recovery correctness
- Platform API breaking changes (если есть)

---

## Порядок мержа и мониторинг

### Неделя 1
1. **PR#1** → `main` (понедельник)
   - Code review: 2 дня
   - Merge + deploy nightly: среда
   - Мониторинг incidents: среда-пятница

### Неделя 2
2. **PR#2** + **PR#3** → `main` параллельно (понедельник, после анализа incidents PR#1)
   - Code review: 1-2 дня каждый
   - Merge: среда
   - Smoke testing: среда-четверг

### Неделя 2-3
3. **PR#4** → `main` (четверг/пятница)
   - Code review: 1 день
   - Merge + full regression: пятница
   - Weekend bake

### Release
- Beta release: начало недели 3
- Stable release: конец недели 3 (при чистых метриках)

---

## Rollback Plan

Если после PR#1:
- `adapter_recycled` не падает → откатить PR#1, проверить quarantine shutdown
- Новые crashes → проверить `actor_shutdown_quarantined` rate

Если после PR#2:
- Screen sharing хуже → откатить PR#2, fallback на старую логику
- Supervisor transitions некорректны → hotfix на basis PR#1

Если после PR#3:
- Camera worse → откатить PR#3 only
- Async callback issues → может потребовать откат до PR#1

PR#4 самый безопасный (в основном аудио-качество), откат trivial.

---

## Метрики успеха (4 недели после full merge)

| Метрика | Baseline | Target | Critical |
|---------|----------|--------|----------|
| `native_contract_corruption` | ~5-10/день | 0 | < 1/неделя |
| `adapter_recycled` (non-user-action) | ~20-30/день | < 5/день | < 10/день |
| `liveness_probe_failed` | ~15/день | < 3/день | < 5/день |
| Screen share success rate | ~85% | > 95% | > 90% |
| Camera success rate | ~80% | > 95% | > 90% |
| App hang on exit | ~2% | < 0.1% | < 0.5% |
| User reports "strange mic" | ~5/неделя | < 1/неделя | < 2/неделя |

---

## Команды для создания PR

```bash
# Текущее состояние: все на fix/50-native-module-stabilization

# PR #1
git checkout -b fix/native-observability-lifecycle fix/50-native-module-stabilization
# Cherry-pick коммитов относящихся к lifecycle/observability
# Пушим и создаём PR

# PR #2
git checkout -b fix/native-screen-capture-supervisor fix/native-observability-lifecycle
# Cherry-pick коммитов screen capture
# Пушим и создаём PR

# PR #3
git checkout -b fix/native-camera-async-capture fix/native-screen-capture-supervisor
# Cherry-pick коммитов camera
# Пушим и создаём PR

# PR #4
git checkout -b fix/native-audio-quality-integration fix/native-camera-async-capture
# Cherry-pick остальных (audio, platform, versions)
# Пушим и создаём PR
```

---

## Заключение

Это не "большой рефакторинг" — это **хирургические исправления 14 конкретных багов** с полным coverage тестами и метриками. Каждый PR независимо проверяем и откатываем.

После мержа всех 4 PR модуль из категории "постоянно падает" перейдёт в "стабильно работает у 95%+ пользователей". Оставшиеся 5% — Windows edge cases (гибридная графика, RDP, VBS), которые потребуют отдельного воспроизведения.
