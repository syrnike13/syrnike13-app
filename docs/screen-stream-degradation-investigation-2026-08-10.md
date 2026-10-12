# Исправление накопительной деградации демонстрации экрана

Дата: 10 августа 2026 года.

## Итог

Исправлены все воспроизводимые в изолированных тестах причины накопительной
деградации screen share:

1. viewer health больше не считается здоровым только потому, что native decoder
   продолжает выдавать кадры;
2. зависшая Electron shared-texture presentation получает точечное
   восстановление, а исчерпание retained GPU budget приводит к renderer reload;
3. release retry chains ограничены по числу попыток и отменяются при dispose и
   смене native runtime epoch;
4. remote-audio overflow сохраняет свежий 20-миллисекундный recovery prebuffer,
   а не выбрасывает всю очередь и не создаёт дополнительную паузу;
5. screen-audio packetizer больше не создаёт vector и не делает prefix erase
   каждые 10 мс; блокирующий LiveKit acknowledgement выполняется только после
   `IAudioCaptureClient::ReleaseBuffer`;
6. publisher encoder/backpressure/RTP stalls завершают повреждённый pipeline
   типизированной причиной и запускают существующий bounded republish с новой
   screen generation.

Основная подтверждённая причина была на стороне зрителя, но исправление сделано
симметрично для viewer и publisher.

## Основная причина viewer degradation

До исправления `NativeMediaController` обновлял `lastFrameAt` на событии
`remoteVideoFrame`, то есть на стадии native decode. При этом
`NativeSharedTextureBridge` мог уже постоянно отклонять кадры, потому что
Electron не возвращал `allReferencesReleased` для предыдущих GPU textures.

Получался split-brain:

- LiveKit/native decoder продолжает выдавать кадры;
- controller постоянно переносит health timeout;
- shared-texture bridge исчерпал retained budget и отклоняет кадры;
- renderer не получает изображение;
- `retryRemoteVideo` не запускается;
- новый session/generation после перехода временно возвращает presentation
  budget.

Изолированный regression test:

`apps/desktop/src/main/native-video/screen-stream-viewer-liveness.test.ts`

После исправления health обновляется только после успешного результата
`NativeSharedTextureBridge.deliverEffect()`.

Production paths:

- `apps/desktop/src/main/native-media-engine.ts`
- `apps/desktop/src/main/native-runtime/native-media-controller.ts`
- `apps/desktop/src/main/native-video/shared-texture-bridge.ts`

## Viewer presentation recovery

Добавлен отдельный recovery policy:

`apps/desktop/src/main/native-video/presentation-recovery.ts`

Обычный presentation stall:

1. main отправляет renderer reset для конкретного
   `session:generation:track`;
2. renderer закрывает pending `VideoFrame`, отменяет rAF и сбрасывает canvas
   backing store;
3. remote track запускает `recoverRemoteVideoDemand`;
4. local screen preview переутверждается demand-последовательностью
   `false → true`.

Если достигнут hard retained reference cap, recovery повышается до
`webContents.reload()`. Это гарантированно разрушает renderer-owned GPU
references вместо бесконечного отклонения новых кадров.

IPC и renderer paths:

- `packages/platform/src/ipc.ts`
- `apps/desktop/src/preload/index.ts`
- `apps/web/src/features/voice/native-video-registry.ts`

Renderer reset сохраняет adapter и mounted canvas consumer, поэтому React не
остаётся привязанным к orphaned consumers map. Следующий кадр рисуется в тот же
canvas.

## Shared-texture release lifecycle

До исправления каждый неудачный native release создавал бесконечную
exponential retry chain.

Теперь:

- default budget: 6 attempts;
- delay ограничен 1 секундой;
- одновременно существует максимум одна release operation на frame key;
- операции отменяются при dispose;
- операции старого runtime epoch отменяются при runtime turnover;
- окончательная ошибка логируется, но не создаёт вечный timer chain.

Regression tests:

- `apps/desktop/src/main/native-video/screen-stream-release-retry.test.ts`
- `apps/desktop/src/main/native-video/shared-texture-bridge.test.ts`

## Remote audio overflow

До исправления overflow после заполнения 15 packet slots:

1. отбрасывал следующий packet;
2. публиковал discontinuity;
3. сбрасывал все накопленные 150 мс;
4. заново ждал 20 мс prebuffer.

Теперь overflow сохраняет два самых свежих 10-миллисекундных packet. Это ровно
существующий 20-миллисекундный playout prebuffer, поэтому renderer может
возобновить звук сразу после discontinuity reset.

Invalid format остаётся более строгим случаем и полностью очищает очередь.
Оба места проверки concurrent discontinuity используют один recovery helper,
поэтому копирование frame не может вернуть stale packet после raced overflow.

Production paths:

- `packages/desktop-native/native/src/media/remote_audio_ingress.hpp`
- `packages/desktop-native/native/src/media/remote_audio_ingress.cpp`
- `packages/desktop-native/native/src/media/remote_audio_output.cpp`

Tests:

- `packages/desktop-native/native/tests/remote_audio_ingress_soak_test.cpp`
- `packages/desktop-native/native/tests/media_processing_test.cpp`

## Screen-audio realtime path

До исправления packetizer:

- расширял `std::vector`;
- создавал новый packet vector каждые 10 мс;
- делал `erase(begin, begin + packet)`;
- в промежуточной версии мог ждать `captureFrame(..., 0)` до освобождения
  WASAPI capture buffer.

Теперь `FixedAudioPacketQueue` использует compile-time fixed storage. WASAPI
samples сначала копируются в bounded packet slots, затем capture buffer
освобождается, и только после этого готовые 10-миллисекундные frames
последовательно отправляются в LiveKit.

Production paths:

- `packages/desktop-native/native/src/media/screen_audio_packetizer.hpp`
- `packages/desktop-native/native/src/media/screen_audio_capture.cpp`

Test:

`packages/desktop-native/native/tests/screen_audio_packetizer_soak_test.cpp`

Тест проверяет 100 000 packets, порядок PCM, wrap/reuse, discontinuity partial
reset и жёсткую fixed-capacity границу.

## Publisher symmetric recovery

До исправления следующие состояния только логировались:

- encoder input/backpressure без progress в течение 2 секунд;
- submitted frames без encoder output в течение 5 секунд;
- encoded frames без RTP output в течение 5 секунд.

Теперь pipeline завершается одним из typed reasons:

- `encoder_backpressure_stalled`;
- `encoder_output_stalled`;
- `rtp_output_stalled`.

`NativeRtcEngineAdapter` классифицирует их как retryable, retire-ит повреждённую
screen generation и после существующего bounded backoff создаёт новую
`startScreenCapture` generation.

Static screen не считается stall, если submitted/encoded/sent counters
согласованно не меняются.

Production paths:

- `packages/desktop-native/native/src/media/screen_pipeline_stall.hpp`
- `packages/desktop-native/native/src/media/screen_actor.cpp`
- `apps/desktop/src/main/voice/native-rtc-engine-adapter.ts`

Tests:

- `packages/desktop-native/native/tests/screen_stream_publisher_policy_soak_test.cpp`
- `apps/desktop/src/main/voice/native-rtc-engine-adapter.test.ts`

## Метрики и automatic reports до crash

Диагностика больше не ждёт падения процесса. Около-критичные состояния
становятся типизированными incidents и проходят существующий account-owned
upload pipeline:

```text
detector
  → Electron main incident lease
  → authenticated renderer upload executor
  → normalized gzip JSONL bundle
  → /diagnostics/reports
```

Main process автоматически создаёт incidents для:

- `presentation_stalled`;
- `remote_video_recovery_degraded`;
- `shared_texture_operation_failed`;
- `screen_pipeline_stalled`;
- исчерпания retained texture budget и неудачного renderer recovery.

Renderer health monitor создаёт incidents после трёх последовательных
деградировавших samples:

| Trigger | Порог |
| --- | --- |
| `screen_publication_stalled` | local screen опубликован, но capture/RTP progress отсутствует |
| `screen_subscription_stalled` | remote screen подписан, но track/payload не готов |
| `screen_frames_dropped_critical` | минимум 20% и 5 dropped frames/s |
| `rtc_audio_concealment_critical` | минимум 20% concealed audio |
| `rtc_packet_loss_critical` | минимум 10% packet loss |
| `rtc_jitter_critical` | минимум 100 ms |
| `rtc_latency_critical` | минимум 400 ms ping |

Transient spike не создаёт report. После recovery trigger re-arm-ится и может
сообщить о новой отдельной деградации.

Production paths:

- `apps/desktop/src/main/native-runtime/diagnostic-incidents.ts`
- `apps/desktop/src/main/native-runtime/anonymous-metrics.ts`
- `apps/web/src/features/voice/rtc-health-monitor.ts`
- `apps/web/src/features/voice/voice-provider.tsx`
- `services/backend/crates/delta/src/routes/telemetry.rs`

## Что теперь находится в отчёте

Incident summary поддерживает до 48 конечных числовых metrics. Идентификаторы
account, user, participant, room, channel и source не попадают в anonymous
Prometheus batch. Для подробного authenticated report renderer сначала пишет
sanitized evidence в diagnostic ring, поэтому bundle содержит:

- физически удержанные GPU textures и bytes;
- cumulative rejected/stale/capacity drops отдельно от retained frames;
- возраст самой старой retained texture;
- shared-texture import/send/release failures;
- recovery attempt, outcome и duration;
- capture frames/no-frame/backpressure;
- GPU pool, slot timeout, rollover, quarantine и stale-drop counters;
- encoder implementation и encoded/sent RTP frames, packets и bytes;
- screen-audio frames/packets;
- packet loss, jitter, latency, frame-drop и concealment percentages;
- пороги, число последовательных samples и факт последующего recovery.

Пример различия:

```text
retainedFrames = 1
rejectedFrames = 18 000
```

Это означает не 18 000 одновременно «мёртвых» textures, а одну всё ещё
удерживаемую GPU reference и 18 000 кадров, которые bounded bridge отказался
импортировать после исчерпания presentation budget.

Bundle regression:

`apps/desktop/src/main/screen-stream-report-bundle.test.ts`

Он собирает один gzip bundle и проверяет совместное присутствие viewer GPU
evidence, publisher RTP/capture/audio evidence и renderer RTC health incident.

## Anonymous SLO metrics

Prometheus получает только allowlisted low-cardinality labels:
`event/operation`, `runtime`, `session_kind`, `release_channel`.

Counters:

- `screen_presentation_stalled`;
- `screen_presentation_recovery_requested`;
- `screen_presentation_recovered`;
- `screen_presentation_recovery_failed`;
- `screen_renderer_reloaded`;
- `screen_shared_texture_operation_failed`;
- `screen_publisher_stalled`;
- `screen_publisher_republished`;
- `screen_publication_stalled`;
- `screen_subscription_stalled`;
- `screen_frames_dropped_critical`;
- `rtc_audio_concealment_critical`;
- `rtc_packet_loss_critical`;
- `rtc_jitter_critical`;
- `rtc_latency_critical`.

Histograms:

- `screen_presentation_recovery_ms`;
- `screen_retained_texture_age_ms`;
- `screen_publisher_republish_ms`.

Raw frame drops не создают отдельный upload на каждый кадр. Они агрегируются в
bounded cumulative counter внутри incident/report, а anonymous reporter
coalesce-ит samples и ограничивает batch.

## Защита от report storm

- одинаковые incidents агрегируются в течение 5 секунд;
- native automatic report имеет client cooldown 1 минуту;
- renderer health report по умолчанию имеет client cooldown 10 минут;
- pending queue, metrics count, batch size и payload size ограничены;
- неуспешный upload возвращает lease с bounded retry/backoff;
- backend дополнительно применяет rate limit и независимо валидирует gzip,
  manifest и каждую JSONL envelope.

## Проверки

### Раздельные regression/soak suites

Успешно:

```text
Viewer bridge/recovery/release:
  4 test files, 25 tests

Preload presentation bridge:
  1 test file, 5 tests

Renderer registry + 100k frame soak:
  2 test files, 28 tests

NativeMediaController:
  1 test file, 32 tests

NativeRtcEngineAdapter:
  1 test file, 40 tests

Native audio/publisher subset:
  4 CTest targets, all passed

RTC health thresholds/re-arm:
  1 test file, 7 tests

Screen incidents/metrics/bundle:
  4 test files, 10 tests

Backend telemetry allowlist:
  focused Rust test passed for all 15 counters and 3 histograms
```

### Широкая проверка

Успешно:

```text
Desktop Vitest: 42 files, 364 tests
Native CTest:   26/26 tests
Native utility smoke harness: 5/5 tests
Desktop typecheck
Web production build
Desktop shell + native runtime build
Focused backend telemetry route test
Focused rustfmt check for telemetry.rs
```

Full web Vitest после синхронизации debug-view fixture с обязательным
`rates.quality`: 208 files, 1049 tests, все прошли.

`pnpm backend:check` не завершён из-за локального Windows toolchain blocker:
`openssl-sys` не нашёл OpenSSL/vcpkg installation. Изменённый
`syrnike-delta` telemetry route при этом отдельно скомпилирован и его focused
test прошёл. Никакая установка или перенастройка toolchain не выполнялась.

## Ограничения проверки

Приложение и реальная демонстрация экрана не запускались, как требовалось.
Pure tests и production build не могут физически воспроизвести:

- vendor-specific D3D/Electron fence failure;
- реальную деградацию Media Foundation H264 MFT/driver;
- WASAPI scheduling под одновременной GPU/CPU нагрузкой;
- реальную WebRTC congestion-control сеть.

Для этих пунктов после доставки нужен отдельный продолжительный hardware soak
на затронутых Windows машинах. Кодовые liveness, queue, retry и recovery
контракты, которые позволяли деградации становиться постоянной, теперь покрыты
детерминированными отдельными тестами.
