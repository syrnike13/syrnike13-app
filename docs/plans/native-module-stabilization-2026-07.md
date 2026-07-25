# Аудит нативного Windows-модуля (`packages/desktop-native`) и план стабилизации

**Дата:** 2026-07-25
**Ветка на момент аудита:** `fix/50-screen-publication-recovery` (HEAD `0794594c`)
**Объём:** ~28 000 строк C++ (`native/src`, `native/tests`) + TS-интеграция (`apps/desktop/src/main/native-runtime`, `native-media-engine.ts`, `apps/desktop/src/utility/runtime-host.ts`)

---

## 0. Резюме и вердикт

**Модуль переписывать с нуля НЕ нужно.** Архитектура спроектирована выше среднего уровня: акторная модель с мэйлбоксами, generation fences против устаревших команд, zero-copy GPU-путь экрана (NV12 + keyed mutex до аппаратного H264-энкодера), дисциплинированное владение ресурсами (`on_drop`-гарды), изоляция в utility-процессе с верификацией контракта, грамотная классификация HRESULT. Переписывание с нуля потеряет накопленные грабли (зафиксированные в комментариях кода) и создаст новые.

**Проблема системная, но локализуемая:** happy path вылизан, а границы жизненного цикла (shutdown, reconnect, отвал/смена устройства, отсутствие кадров) — дырявые. Все жалобы («странные вылеты», нестабильные демонстрации/камеры, странный захват микрофона») сводятся к четырём корневым причинам:

| # | Корневая причина | Симптом у пользователя |
|---|---|---|
| КП-1 | Штатные ошибки казнятся как фатальные: `reply` без `requestId` = «contract corruption» = `process.exit(1)`; `std::terminate()` при переполнении очередей (~8 мест); `degraded` необратим | «Странные вылеты», медиа умирает посреди звонка и не восстанавливается |
| КП-2 | Пробы живости супервизора (1 с) против легально блокирующих операций (5–10 с) на том же мэйлбоксе | Рестарты медиа-хоста при смене/отвале микрофона |
| КП-3 | Recovery экрана размазан по 3 несогласованным слоям; блокирующие вызовы без таймаутов в capture-потоках | Чёрный/замёрзший экран, моргание, зависание приложения при выходе |
| КП-4 | Камера: синхронный `ReadSample` без таймаута, нет отслеживания удаления устройства | Вечный hang при отвале USB/виртуальной камеры |

**Отягчающее:** нативная диагностика выключена по умолчанию (`SYRNIKE_NATIVE_MEDIA_DIAGNOSTICS=1`) и `stdio: 'ignore'` у utility-процесса — крэши у пользователей не оставляют следов. Команда несколько недель дебажит вслепую.

**Стратегия:** 6 фаз, от наблюдаемости и снятия «казней» (дни) до хирургии recovery-слоя экрана и capture-слоя камеры (2–3 недели). Control plane (`*PublicationController` + `GenerationFence` + `ActorMailbox`) — сохранить, там только точечные правки.

---

## 1. Карта архитектуры (как есть)

### 1.1 Хостинг
- Аддон живёт **только** в Electron `utilityProcess` (`apps/desktop/src/main/native-runtime/utility-adapter.ts:129-135`): `utilityProcess.fork(out/utility/media-host.cjs, ..., { serviceName: 'syrnike-media-runtime', stdio: 'ignore' })`. В main-процесс нативный код не загружается — крэш нативки не роняет UI.
- Окружение дочернего процесса — жёсткий allowlist (`utility-adapter.ts:20-28`) + `SYRNIKE_NATIVE_*` (`:88-102`).
- Хост (`apps/desktop/src/utility/runtime-host.ts`): валидация env → верификация манифеста артефактов → `require(<addon>)` → сверка commit/napi/livekit/capabilities (`:314-353`) → `factory(emit)`.
- `media_addon.cpp:22-55`: `livekit.dll` грузится вручную с `LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR`; рантайм — строгий singleton на процесс (`:175-180`).
- Супервизор (`runtime-supervisor.ts`): рестарты с задержками (3 попытки в окне 60 с), после 4-го сбоя — circuit open → `degrade()`.

### 1.2 Нативное ядро
- `MediaRuntime::Implementation` (pimpl) в конструкторе поднимает главный поток `run()` (`media_runtime.cpp:99`), который инициализирует COM (MTA), берёт `LiveKitLease` (глобальные `livekit::initialize/shutdown`) и порождает **5 воркеров**: voice, microphone, screen, camera, query (`media_runtime.cpp:1294-1318`).
- Очереди: `ActorMailbox` (voice/screen/camera — control-ring 256 + коалесинг-слоты 64 по ключу type/session/gen/track) и `BoundedQueue` (microphone/query 256).
- `GenerationFence` (по домену: voice/mic/mic-warm/screen/camera) — монотонная пара `{session_id, generation}`; `advance` в `dispatch()`, `isCurrent` в обработчиках, `restoreIfCurrent` при отказе enqueue.
- Актёры (`MicrophoneActor`, `ScreenActor`, `CameraActor`, `VoiceActor`, `PreviewActor`) владеют собственными потоками (capture, sink, render, attempt/retire) и своими publication-контроллерами.
- Исходящий путь: актёр → `SequencedEmitter` (мьютекс + монотонный sequence) → `NodeEventSink` с **тремя** ThreadSafeFunction-полосами на одну JS-функцию: control (queue 512), media (коалесцирующая через `CoalescingEventLane`, lossy), telemetry (`node_event_sink.cpp:387-408`).
- Владение GPU-ресурсами передаётся через `on_drop` (`runtime_types.hpp:130`); `RuntimeEventResourceGuard`/`ActorCommandResourceGuard` — fallback-освобождение на обрыве.
- LiveKit: `RealLiveKitPublicationClient` (один `mutex_`, один `voice_room_`) → `RealLiveKitRoomOwner` → `PostedRoomDelegate` (владеет `RemoteAudioOutput` + двумя `RemoteVideoBridge`); коллбэки LiveKit конвертируются в `MediaCommand` и постятся обратно в voice-mailbox; `CallbackGuard` + `beginShutdown/waitForCallbacks` — барьер против коллбэков после teardown.
- Общая философия — **fail closed**: потеря control-события или переполнение control-очереди → намеренный `std::terminate()`, расчёт на перезапуск utility-процесса супервизором.

### 1.3 Захват экрана
- Выбор источника: `display_sources.cpp:393` (`EnumDisplayMonitors` + `EnumWindows`), id `screen:N` / `window:<HWND>` / `game:<HWND>`; парсинг — `screen_capture_target.cpp:55`.
- Фабрика `ScreenGpuCapturer::create` (`screen_gpu_capture.cpp:1561`): окно/игра → только WGC (`WgcGpuCapturer`, `:1113`); монитор → `MonitorGpuCapturer` (`:1447`): сначала DXGI Desktop Duplication, при неудаче WGC.
- DXGI-ветка (`:1000`): `AcquireNextFrame(1ms)` → `DxgiFrameCompositor::compose` (HLSL: курсор + поворот, `screen_dxgi_compositor.cpp:332`) → `GpuFramePool::process` → `preview_.process` → `ReleaseFrame`.
- `GpuFramePool` (`:281`): 5 слотов NV12 с `SHARED_NTHANDLE | KEYED_MUTEX`, BGRA→NV12 через `ID3D11VideoProcessor` (BT.709 16-235); продюсер — ключ 0, консьюмер — ключ 1. Кадр наружу — `ScreenGpuFrame` с shared-хэндлом → `ScreenTextureLease` (`screen_actor.cpp:67`) → `livekit::D3D11TextureLease` → аппаратный `D3D11H264VideoSource`. **Zero-copy до энкодера — сделано правильно.**
- `GpuPreviewPool` (`:601`): 3 BGRA-слота для локального превью, хэндл дублируется в Electron через `DuplicateHandle` (`:747`).
- Аудио экрана: `screen_audio_capture.cpp` — WASAPI process loopback (`ActivateAudioInterfaceAsync` + `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`).
- Управление: `ScreenActor` → `ScreenPublicationController` (состояния `prepared_/candidate_/active_/retiring_/deferred_retire_/pending_restart_`), всё сериализовано мэйлбоксом + `GenerationFence`.

### 1.4 Камера
- `camera_capture.cpp`: Media Foundation `IMFSourceReader` в **синхронном** режиме (без `IMFSourceReaderCallback`). Выход `MFVideoFormat_RGB32` с `MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING=TRUE`; negotiation (`rankCameraOutputFormats`, `:396`) первым всегда ставит запрошенный формат (`:412`) — фактически полагается на встроенный конвертер MF. Кадр копируется на CPU (`copyCameraBgraRows`) → софтверный `livekit::VideoSource`. GPU-пути нет.

### 1.5 Аудио
- Микрофон: WASAPI shared, **polling** (`GetNextPacketSize` + `sleep_for(2ms)`, `microphone_actor.cpp:1069-1071`), буфер 1 с, без `EVENTCALLBACK`. AEC-опора: `microphone_echo_reference.cpp` с дефолтного render-эндпоинта; APM WebRTC (`microphone_audio_processor.cpp`), `setStreamDelayMs(50)` захардкожен. Voice gate (`voice_gate.cpp`) с lookahead только в auto-режиме.
- Рендер: `remote_audio_output.cpp`, polling `wait_for(2ms)`, категория `AudioCategory_GameChat` (`:707`).
- Мониторинг устройств: `AudioEndpointMonitor` (`audio_devices.cpp`), роль `eCommunications` (`:45`, `:228`).

### 1.6 Мёртвый код
- `screen_video_capture.cpp` (548 строк CPU-readback DXGI/WGC) **не входит** в `syrnike_media_core` — только в бенчмарк-таргет (`CMakeLists.txt:398-399`). При отладке инцидентов стабильно уводит не туда.

---

## 2. Полный реестр находок

Формат: **ID. [Серьёзность] Название** — файл:строки. Описание → последствие.

### 2.A Ядро: lifecycle, shutdown, N-API (виновники «странных вылетов»)

**A1. [КРИТИЧНО] Порядок разрушения членов: очереди умирают раньше акторов → use-after-free** — `media_runtime.cpp:1384-1396`.
Члены объявлены: актёры (`microphone_`, `screen_`, `camera_`, `voice_`) *раньше* очередей (`voice_commands_`, `microphone_commands_`, `screen_commands_`, `camera_commands_`). Разрушение идёт в обратном порядке → **все 5 очередей уничтожаются раньше всех 5 актёров**. Любой ещё живой поток актёра, вызывающий `post_` → `postInternal(queue, …)` (`media_runtime.cpp:399`), пишет в освобождённую память. Про `emitter_` (объявлен первым) подумали (комментарий `:389-392`), про очереди — нет.

**A2. [КРИТИЧНО] `MicrophoneActor::shutdown()` не останавливает монитор аудио-эндпоинтов** — `microphone_actor.cpp:456-462` (shutdown), `:86-97` (создание), `:1210` (член).
`shutdown()` делает `publication_.shutdown(); shutdownSinks(); stopCapture();` — `endpoint_monitor_` не трогается и живёт до деструктора. Его COM-поток захватывает `this` и постит `__microphoneEndpointChanged` в `microphone_commands_`. В связке с A1: **выдернули наушники/микрофон во время выхода → пост в уничтоженную очередь → крэш**.

**A3. [КРИТИЧНО] Дедлок `emitter_.close()` ↔ JS-колбэк** — `sequenced_emitter.hpp:37-40`, `node_event_sink.cpp:502-509`, `media_runtime.cpp:393`.
`SequencedEmitter::close()` держит `mutex_` во время `NodeEventSink::close()`, который делает `waitForInFlightCallbacks()`. Поток A (libuv pool, `ShutdownWorker::Execute`) держит мьютекс и ждёт JS; поток B (JS main) внутри media-колбэка синхронно вызывает `runtime.dispatch(...)` → `emitter_.emit(...)` → блокируется на том же мьютексе. Взаимная блокировка, зависание на shutdown.

**A4. [КРИТИЧНО] Гонка `dispatch()`/`close()` → `std::terminate()`** — `media_runtime.cpp:116, 135, 209`, `node_event_sink.cpp:415-419`, `sequenced_emitter.hpp:34`.
`dispatch()` проверяет `shutting_down_` один раз, затем может `emitter_.emit(failedReply(...))`. Если между проверкой и emit другой поток выполнил `emitter_.close()`, control-emit вернёт `false` → `std::terminate()`. `dispatch` идёт с JS-потока, shutdown — с пула libuv: гонка реальная.

**A5. [КРИТИЧНО] Исключение из JS-обработчика убивает процесс** — `node_event_sink.cpp:334-342`, `event_sink.hpp:96-105`.
`transferEventToConsumer` ловит **любое** исключение, включая `Napi::Error` от JS-исключения в колбэке; `!delivered && lane == control` → `std::terminate()`. Любая необработанная ошибка в JS-listener'е → мгновенный крэш utility-процесса без стека.

**A6. [ВЫСОКИЙ] Переполнение control-полосы TSFN = `std::terminate()`** — `node_event_sink.cpp:387-393` (queue 512) + `sequenced_emitter.hpp:34`.
JS-поток занят (GC, синхронный IPC) → >512 control-событий → `napi_queue_full` → terminate. Backpressure-крэш, вероятность растёт с числом участников комнаты.

**A7. [ВЫСОКИЙ] `connectVoice` разрушает старую Room под общим мьютексом** — `livekit_publication_client.cpp:970-993`, `:793-808`.
`voice_room_.reset()` под `mutex_` → `~RealLiveKitRoomOwner`: `close()` → `waitDisconnected(2s)` → `beginShutdown()` → `waitForCallbacks()` (**без таймаута**). Тот же `mutex_` берут `roomSnapshot()`, `releaseRemoteVideoFrame` (JS-поток!), `isVoiceConnected`, `setVoiceDeafened`. Последствия при make-before-break reconnect: JS main блокируется ≥2 с; voice-воркер блокируется → voice-mailbox (256) переполняется событиями делегата → `postInternal` → `std::terminate()` (`media_runtime.cpp:425`). **Наиболее вероятный механизм вылета при быстром reconnect.**

**A8. [ВЫСОКИЙ] `livekit::shutdown()` может выполниться раньше уничтожения Room** — `media_runtime.cpp:1374` vs `:1380`.
`LiveKitLease` — локальный в `run()`, разрушается при выходе; `livekit_client_` — член Implementation, умирает позже. Если `voice_.shutdown()` (`:1340`) бросит (в «чистой» ветке не обёрнут в try/catch, в отличие от catch-ветки `:1360`), `voice_room_` переживёт `livekit::shutdown()` → `~Room` по мёртвому FFI-рантайму.

**A9. [СРЕДНИЙ] `napi_remove_async_cleanup_hook` вызывается не из loop-потока** — `media_addon.cpp:76-82`.
`asyncCleanup` порождает detached-поток, который делает `cleanupRuntimes()` + `DiagnosticLog::shutdown()` + `napi_remove_async_cleanup_hook(handle)` — всё вне loop-потока. Канон Node — вернуться через `uv_async_send`. `cleanupRuntimes()` в этом потоке доходит до `TSFN::Release()` во время teardown окружения → крэши «при выгрузке аддона».

**A10. [СРЕДНИЙ] `runtime_constructor` — process-global на per-env ссылку** — `media_addon.cpp:20, 165-166, 264`; дубль в `hooks_addon.cpp:57`.
Статическая `Napi::FunctionReference`, перезаписываемая при инициализации в новом окружении (worker_thread/второй контекст). Использование конструктора чужого env → крэш; `SuppressDestruct()` утекает старую ссылку.

**A11. [СРЕДНИЙ] `active_runtime` не освобождается без явного `shutdown()`** — `media_addon.cpp:19, 71-74, 176-179`.
`~MediaRuntimeBinding` не определён. JS уронил объект без `shutdown()` → все потоки/TSFN/Room живут, повторный `createMediaRuntime` → `runtime_already_created`. Восстановление в том же процессе невозможно.

**A12. [СРЕДНИЙ] `ShutdownWorker::Execute` без try/catch** — `media_addon.cpp:92-99`.
`shutdownAndWait()` может бросить (`TSFN::Release()` бросает `Napi::Error`); `releaseRuntime` из `OnOK` не выполнится, рантайм останется наполовину разобранным.

**A13. [СРЕДНИЙ] Неограниченный рост `released_frame_sequences_`** — `remote_video_bridge.cpp:465-480`, `remote_video_bridge.hpp:111`.
`release()` для неизвестной пары (двойной release, произвольный `frameSequence` из JS) навсегда добавляет запись в никогда не чистящийся `unordered_set`. Утечка + вектор злоупотребления.

**A14. [НИЗКИЙ/СРЕДНИЙ] Lossy-методы `CoalescingEventLane`, теряющие `on_drop`** — `coalescing_event_lane.hpp:112-125` (`take`), `:162-164`, `:170-176` (`close`).
Возвращают события без вызова `on_drop`. Сейчас используются только правильные `closeAndDiscard`/`cancelScheduledCallbackAndDiscard`, но API-ловушка оставлена: первое использование `close()`/`take()` = утечка GPU-текстур и NT-handle'ов.

**A15. [НИЗКИЙ] `PreviewActor::worker_` управляется без синхронизации** — `preview_actor.cpp:147-159, 116, 51`.
`joinable()/join()` из трёх мест без мьютекса; инвариант держится на порядке в `run()` (`media_runtime.cpp:1329` vs `:1336`) и нигде не задокументирован.

**A16. [НИЗКИЙ] Busy-wait без верхней границы** — `voice_actor.cpp:86-88`, `remote_video_bridge.cpp:256-258, 364-366`, `d3d11_gpu_completion.hpp:44-63`.
`while (!committed) yield();` — commit-барьеры; `SwitchToThread()`-спин до 500 мс на кадр в `D3d11GpuCompletion::wait`. На 60 fps × N треков — выжигание ядра; плюс отдельный `ID3D11Device` на каждый remote-трек (`remote_video_bridge.cpp:261`).

**A17. [НИЗКИЙ] `terminate()` из `catch(...)` в путях освобождения ресурсов** — `actor_mailbox.hpp:57, 237, 246`, `lifetime_safe_frame_release.hpp:25`.
Любое исключение из `on_drop` убивает процесс; `on_drop` в `media_runtime.cpp:916` вызывает `screen_.handleWorkerCommand(release)` (мьютекс + `ScreenGpuCapturer`) — путь не «невозможный».

**A18. [ПОЛОЖИТЕЛЬНОЕ] HRESULT-обработка систематически аккуратная.** `audio_failure.cpp` классифицирует коды; `screen_gpu_capture.cpp:1005-1024` разделяет `ACCESS_LOST` (recoverable) и `DEVICE_REMOVED/RESET` (fatal); `d3d11_gpu_completion.hpp:58` проверяет `GetDeviceRemovedReason()`; `audio_devices.cpp:307-330` — образцовый разбор `UnregisterEndpointNotificationCallback` (осознанная утечка вместо UAF). Проблемы не в HRESULT, а в lifetime/shutdown.

### 2.B Захват экрана

**B1. [КРИТИЧНО] Блокирующий WinRT-вызов без таймаута в capture-потоке → вечный hang приложения** — `screen_gpu_capture.cpp:70-88` (критично `:81`), вызов из `WgcGpuCapturer::initialize()` (`:1397`).
`GraphicsCaptureAccess::RequestAccessAsync(...).get()` без таймаута — и при старте, и при **каждом рестарте** в `handleNoFrame`. Залипший шелл/брокер (explorer, RDP, смена пользователя) → capture-поток встаёт навсегда → `cleanupResources` делает `capture_thread.join()` (`screen_publication_controller.cpp:1016`) → retire-воркер не завершается → `drainRetirements()` (`:1186`) в `shutdown()` висит → **приложение не закрывается**.

**B2. [КРИТИЧНО] WGC пересоздаёт сессию каждые 2 секунды на статичном экране** — `screen_gpu_capture.cpp:1271-1287`.
WGC легально не выдаёт кадров, когда содержимое не меняется (неподвижный десктоп, свёрнутое окно, lock screen). Код через `stall_timeout = 2 s` сносит `GraphicsCaptureSession` + `FramePool` и создаёт заново — бесконечно, каждые 2 с. Последствия: моргание/чёрные кадры у зрителей, поток `RecoverableLost`, дёрганье `disableCaptureBorderIfAllowed` (см. B1) каждые 2 с, всплески GPU. «Нет кадров» и «сессия сломана» неразличимы — архитектурная ошибка, а не опечатка.

**B3. [КРИТИЧНО] DXGI-путь не имеет watchdog'а на замёрзший кадр** — `screen_gpu_capture.cpp:1005`, `screen_actor.hpp:82-85`.
`DXGI_ERROR_WAIT_TIMEOUT` → `NoFrame`, и всё; `ScreenOutputStallDetector` явно трактует «нет кадров захвата и нет кадров энкодера» как норму. Если duplication тихо перестал отдавать кадры (полноэкранное приложение, смена режима питания GPU, гибридная графика) — картинка замирает навсегда, без ошибки, без recovery. Классический «замёрзший экран без сообщения».

**B4. [ВЫСОКИЙ] Fallback только DXGI→WGC; device-removed на WGC = смерть сессии** — `screen_gpu_capture.cpp:1470-1490` (`:1472`).
После перехода на WGC любой `FatalError` (в т.ч. `DXGI_ERROR_DEVICE_REMOVED` при TDR драйвера — типичное явление) → `screen_actor.cpp:748-772` → `__screenTerminal` → сессия убита. Пересоздания девайса нет; возврата на DXGI нет никогда, даже когда причина (UAC, полный экран) ушла.

**B5. [ВЫСОКИЙ] Безлимитный ретрай `switchToWgc` без backoff — создание D3D-девайса на каждый кадр** — `screen_gpu_capture.cpp:1474-1482`, `screen_gpu_capture.hpp:53-57`, глотание через `catch (...)` `:1538`.
`consecutive_recoveries_` не сбрасывается при `RecoverableLost` → `shouldFallback` истинен каждый кадр → каждые ~33 мс: `selectAdapter` (перечисление адаптеров) + `D3D11CreateDevice` + WGC item + `RequestAccessAsync().get()`. При сбрасывающемся драйвере `D3D11CreateDevice` занимает секунды → система неюзабельна.

**B6. [ВЫСОКИЙ] `GpuFramePool::discard` молча теряет слот навсегда** — `screen_gpu_capture.cpp:454-464`, вызов из `ScreenTextureLease::release` (`screen_actor.cpp:91-96`).
`AcquireSync(kConsumerKey, 0)` — таймаут 0; если энкодер держит мьютекс, слот не возвращается, повтора нет (`released_`-защита). 5 гонок → `process()` навсегда `EncoderBackpressure` (`:450`) → восстановление только полным рестартом публикации. Ошибка `AcquireSync` не логируется.

**B7. [ВЫСОКИЙ] Утечка целого capturer'а, если Electron не вернул превью-кадр** — `screen_actor.cpp:940-960`, `GpuPreviewPool` `:817-825`, слоты `:976`.
Renderer/GPU-процесс упал, не вызвав `releaseLocalScreenPreviewFrame` → `previewFramesInFlight()` никогда не 0 → запись в `preview_capturers_` вечна → живут WGC-сессия (`StartCapture` не остановлен), D3D11-девайс, DXGI duplication, 5 NV12 + 3 BGRA текстур. Таймаута на in-flight нет. Каждая повисшая демонстрация — перманентная утечка GPU-памяти + фоновая нагрузка на композитор.

**B8. [ВЫСОКИЙ] Разрушение старого capturer'а под `preview_mutex_` блокирует актор** — `screen_actor.cpp:894-908`; stall-рестарт переиспользует поколение — `screen_publication_controller.cpp:303-306`.
Ключ — `session:generation`, stall-рестарт не меняет generation → присваивание `state.capturer = capturer` уничтожает старый `ScreenGpuCapturer` под мьютексом: `~WgcGpuCapturer` → `session_.Close()/frame_pool_.Close()`. Актор-поток на `setPreviewDemand`/`releasePreviewFrame` стоит на `preview_mutex_` → `probe` рапортует `actor_unresponsive` → рестарт хоста (см. E2).

**B9. [ВЫСОКИЙ] Результат `post_` игнорируется в retire-воркере → застревание recovery** — `screen_publication_controller.cpp:1112-1121`, `finishRetire` `:1130`, `:1147`, `throwCapacityOccupied` `:194-210`.
`__screenRetireDone` постится без проверки возврата. Если control-очередь (256) переполнена/закрыта — `retiring_` навсегда: `pending_restart_` не стартует, `startCapture` бросает `capacity_occupied`. Внутреннего таймера разблокировки нет; спасает только внешний `probeScreenActor`.

**B10. [СРЕДНИЙ] `retireResources` бросает `std::logic_error` из terminal-пути** — `screen_publication_controller.cpp:1088-1094`; вызовы без try: `handleTerminal` `:388-391`, `disconnect` `:353-363`.
Третья одновременная отставка → исключение улетает в `media_runtime.cpp:948-958`, где catch-обработчик `__screenTerminal` форсит `desired_screen_` и **пробрасывает дальше**, а `active_` уже перемещён — контроллер в неконсистентном состоянии.

**B11. [СРЕДНИЙ] DXGI-кадр удерживается через две GPU-конверсии и два спин-ожидания** — `screen_gpu_capture.cpp:1046-1060`.
`ReleaseFrame` только после `compose` + `pool_.process` (+`completion_.wait(500ms)`) + `preview_.process` (+ещё 500 мс). Desktop Duplication рассчитан на быстрое освобождение; удержание душит поставку кадров и повышает шанс `ACCESS_LOST`. Правильно: скопировать в свою текстуру и сразу `ReleaseFrame`.

**B12. [СРЕДНИЙ] Спин-ожидание GPU на потоке с `THREAD_PRIORITY_HIGHEST` + MMCSS** — `d3d11_gpu_completion.hpp:44-62`, `screen_capture_priority.cpp:12-13`.
Высокоприоритетный busy-wait (`GetData` + `SwitchToThread`) до 500 мс, **дважды на кадр** (encoder + preview pool), плюс по разу на кадр на каждый remote-видеотрек (`remote_video_bridge.cpp:127`). Прямой вклад в «система подвисает во время демонстрации».

**B13. [СРЕДНИЙ] Нет ретрая с backoff на UAC / secure desktop** — `screen_gpu_capture.cpp:1084-1093`.
Во время secure desktop (UAC, Ctrl+Alt+Del, lock) `DuplicateOutput` → `E_ACCESSDENIED` → мгновенно `FatalError` → безвозвратный WGC (B4). А WGC на secure desktop не отдаёт кадров → триггерится B2. **Один UAC-промпт запускает две патологии одновременно.**

**B14. [СРЕДНИЙ] Блокирующий сбор RTP-статистики в capture-loop** — `screen_actor.cpp:511-529, 776-777`.
`getStats()` + `wait_for(250ms)` раз в секунду в потоке захвата → при 30 fps гарантированный дроп ~7 кадров каждую секунду. Снимать на отдельном таймере.

**B15. [СРЕДНИЙ] Идентификация монитора позиционным индексом** — `display_sources.cpp:328` → `screen_capture_target.cpp:68-75`.
Индекс зависит от порядка `EnumDisplayMonitors`, меняется при подключении/отключении/смене основного монитора → между выбором и стартом пользователь может получить не тот монитор. Нужен стабильный ключ (`DISPLAY_DEVICE.DeviceID`).

**B16. [СРЕДНИЙ] `listDisplaySources` блокируется на зависших окнах и `CAPTUREBLT`** — `display_sources.cpp:229-231, 104-142`.
`SendMessageW(WM_GETICON)` в чужой UI-поток без `SendMessageTimeout(SMTO_ABORTIFHUNG)` — зависшее приложение вешает вызов навсегда. `StretchBlt(SRCCOPY|CAPTUREBLT)` на каждое окно — десятки мс, при 30 окнах — секунды заморозки диалога выбора.

**B17. [НИЗКИЙ] remote_video_bridge: аллокация shared-текстуры на каждый кадр + дефолтный адаптер** — `remote_video_bridge.cpp:101-166`, `:83-86`, `:273`.
`CreateTexture2D` + `CreateSharedHandle` + `OpenProcess` + `DuplicateHandle` на каждый входящий кадр, без пула. Девайс на `nullptr`-адаптере — на гибридных ноутбуках GPU-процесс Electron может сидеть на другом адаптере → отказ импорта или системная копия.

**B18. [НИЗКИЙ] Мелочи экрана:**
- `screen_gpu_capture.cpp:1503-1516` — `takePreviewFrame/takePreviewFailure` опрашивают `dxgi_` после переключения на `wgc_` → устаревшие кадры/ошибки мёртвого бэкенда.
- `screen_actor.cpp:732-735` — `post_` для `__screenRtpStalled` вернул `false` → `rtp_stall_reported` не выставлен → цикл крутится на полном fps при забитом пуле.
- `screen_dxgi_compositor.cpp:284-294, 187-191` — сбой чтения формы курсора (штатно возможен) бросает исключение и убивает весь DXGI-бэкенд, вместо «не рисовать курсор».
- `screen_video_capture.cpp` — 548 строк мёртвого кода (см. §1.6), удалить/перенести в `benchmarks/`.

### 2.C Камера

**C1. [КРИТИЧНО] Синхронный `ReadSample` без таймаута + `join()` → вечный hang** — `camera_capture.cpp:364-379`; `camera_actor.cpp:213` (`stopActive`), `:177-180` (`shutdown`).
Флаг `running` проверяется только до/после блокирующего вызова; прервать `ReadSample` нечем. Хорошие драйверы при отвале вернут `MF_E_VIDEO_RECORDING_DEVICE_INVALIDATED`, но заметная часть UVC/виртуальных камер (OBS Virtual Cam, Snap Camera, ИК-камеры ноутбуков) просто не возвращают управление → `join()` вешает актор навсегда и блокирует выход приложения. **Мониторинга удаления устройства (`WM_DEVICECHANGE` / MF media source events) нет вообще.** Самый вероятный источник «вылетов вебкамеры».

**C2. [ВЫСОКИЙ] `publication_mutex_` удерживается через сетевую публикацию** — `camera_actor.cpp:300-321`, `:76`, `:85-87`, `:329-331`.
Лок берётся до `publishVideoTrack` и держится до конца `runAttempt`; вторая попытка connect встаёт на мьютекс без таймаута; если первая зависла в LiveKit — вторая висит вечно, `shutdown()` её join'ит. Там же спин-барьеры `while (!committed) yield();`.

**C3. [СРЕДНИЙ] Negotiation не проверяет возможности устройства** — `camera_capture.cpp:412, 344-346`; `camera_actor.cpp:406-411`.
Запрошенный формат всегда первый; с `ADVANCED_VIDEO_PROCESSING` MF согласится, вставив софтверный декодер+масштабатор. MJPG/H264-камера на 1080p → полный софтверный декод + ресайз + RGB32 + CPU-копия (~250 МБ/с memcpy на 1080p30) + софтверный кодек LiveKit. Запрошенный fps камеры не проверяется. GPU-пути (аналогичного экрану `MF_SOURCE_READER_D3D_MANAGER` + NV12) нет.

**C4. [НИЗКИЙ] Проглоченные HRESULT** — `camera_capture.cpp:330-333, 490-493`.
`GetAllocatedString` не проверяется; при ошибке `symbolic == nullptr` и пустом `wanted` активируется первое попавшееся устройство независимо от запроса.

### 2.D Аудио / микрофон

**D1. [ВЫСОКИЙ] Весь WASAPI — polling, а не event-driven** — `microphone_actor.cpp:1013-1023, 1069-1071`; `microphone_echo_reference.cpp:152-161, 178-181`; `audio_devices.cpp:457-461, 472-492`; `screen_audio_capture.cpp:212-220, 245-248`; `remote_audio_output.cpp:763-769, 884`.
`Initialize(SHARED, AUTOCONVERTPCM, 1 секунда буфера)` без `EVENTCALLBACK`/`SetEventHandle`; цикл `GetNextPacketSize` + `sleep_for(2ms)`. Джиттер захвата привязан к планировщику; лаг накапливается и выплёскивается пачкой. `AvSetMmThreadCharacteristicsW(L"Pro Audio")` (`:974`) на polling-треде расходуется впустую.

**D2. [ВЫСОКИЙ] «Устройство по умолчанию» = коммуникационное, а не системное** — `audio_devices.cpp:45, 228, 105`.
`GetDefaultAudioEndpoint(flow, eCommunications)`; `OnDefaultDeviceChanged` реагирует **только** на `role == eCommunications`. Пользователь меняет «Устройство по умолчанию» (Console/Multimedia) в панели звука → приложение продолжает писать со старого и **не получает уведомления**. Прямой кандидат на «странную работу микрофона».

**D3. [ВЫСОКИЙ] `DATA_DISCONTINUITY` игнорируется** — `microphone_actor.cpp:1076-1084` (ср. корректную обработку в `screen_audio_capture.cpp:256-258`).
Читается только `BUFFERFLAGS_SILENT`; накопитель `raw_frame` не сбрасывается при разрыве → после glitch'а 10-мс кадры навсегда сдвинуты по фазе → рассинхрон AEC-опоры.

**D4. [ВЫСОКИЙ] AEC-опора берётся не с того устройства** — `microphone_echo_reference.cpp:141` → `audio_devices.cpp:128-130`; фактический вывод — `remote_audio_output.cpp:1013` (`output_device_id_`).
Опора всегда с дефолтного (коммуникационного) render-эндпоинта; если пользователь выбрал другое устройство вывода — AEC работает вхолостую или вредит.

**D5. [СРЕДНИЙ] AEC: нет выравнивания по времени, фиксированная задержка** — `microphone_audio_processor.cpp:128` (`setStreamDelayMs(50)` захардкожен), `microphone_actor.cpp:1093-1098` (`silent_reference` при пустом буфере — для APM это «эха нет» ровно когда оно есть → расхождение адаптивного фильтра).

**D6. [СРЕДНИЙ] Echo-reference не перезапускается после сбоя, UI при этом врёт** — `microphone_echo_reference.cpp:199-206`; рестарт только при смене флага конфигурации (`microphone_actor.cpp:1089-1092`); `MicrophoneAudioProcessorFrame::status` (`microphone_audio_processor.cpp:209-216`) наружу не отдаётся; UI показывает `processingMode(...)` — эхо настройки (`microphone_publication_controller.cpp:29-31, 56-57`). AEC тихо выключается до конца сессии, пользователь видит «включено».

**D7. [СРЕДНИЙ] Пересоздание WebRTC APM на лету** — `microphone_audio_processor.cpp:36-49`, `:22`; `microphone_actor.cpp:1096`.
«Моргание» доступности echo-reference → уничтожение/создание APM в реальном времени → всплеск CPU + сброс адаптивных состояний (NS, HPF).

**D8. [СРЕДНИЙ] Микрофон никогда не закрывается в простое** — `microphone_actor.cpp:105-137` (`warm`), `:754-757` (`captureDemanded()` используется только в `handleEndpointChange`, `:894`).
Захват держится вне звонка → вечный индикатор «микрофон используется» в Windows, устройство удержано. Комментарий `:1001-1004` показывает: про ducking думали (`AudioCategory_Other`), про вечно тёплый поток — нет.

**D9. [СРЕДНИЙ] Ducking возможен со стороны рендера** — `remote_audio_output.cpp:707` (`AudioCategory_GameChat` активирует политику communications activity); `microphone_actor.cpp:995-1011` (`SetClientProperties` не вызывается вовсе при `bypass == false`).

**D10. [СРЕДНИЙ] Блокирующие операции на актор-треде микрофона** — `microphone_actor.cpp:651-668` (`startCapture` ждёт до 5 с первого здорового кадра), `:692-696` (`probeCaptureDevice` 750 мс), `:701-751` (откат ещё с 5-секундным `startCapture`).
Смена устройства блокирует очередь микрофона >10 с. Взаимодействие с супервизором — см. E2.

**D11. [СРЕДНИЙ] Drop-oldest очереди — «time warp» вместо корректного разрыва** — `microphone_actor.cpp:843-845` (sink, 8 кадров), `microphone_echo_reference.cpp:66-68` (опора, 500 мс), `remote_audio_output.cpp:241-251`.
Выбрасывается самый старый кадр → слушатель получает скачок во времени («робот»/заикание).

**D12. [НИЗКИЙ] Voice gate: смена auto/manual меняет латентность и рвёт звук** — `voice_gate.cpp:156-162` (lookahead только в auto), `:83-85, 153` (`resetGateState` теряет накопленные кадры); `audio_processing.cpp:27-33` (attack/hold 240 мс/release/hysteresis/lookahead — жёсткие константы, недоступны для настройки и диагностики «обрезает начало фразы»).

**D13. [НИЗКИЙ] Мелочи** — `microphone_actor.cpp:955-963` (`join()` вне `capture_lifecycle_mutex_` — формальная гонка); `audio_devices.cpp:234-243` (`OnDeviceRemoved`/`OnDeviceStateChanged` не фильтруют flow); `microphone_actor.cpp:1164` (терминал постится только при `was_ready`, `capture_epoch_` уже сдвинут — `isCurrentCaptureFailure` хрупок).

### 2.E Интеграция Electron / супервизор

**E1. [КРИТИЧНО] Сбой внутренней команды диагностируется как повреждение контракта и убивает хост.** Цепочка (воспроизводится выдёргиванием микрофона):
1. `microphone_actor.cpp:902-911` — `handleEndpointChange` при неудачном `ensureCapture` делает `throw;`.
2. Команда `__microphoneEndpointChanged` без `request_id` → `commandLoop` эмитит `failedReply` (`media_runtime.cpp:1221`).
3. `node_event_sink.cpp:20-22` — `setIfPresent` не кладёт пустую строку → уходит `{ type:'reply', ok:false }` **без `requestId`**.
4. `runtime-host.ts:270` — `isNativeReplyEvent` требует `typeof requestId === 'string'` → false; `isNativeRuntimeEvent` для `reply` → false (`contract.ts:936-937`, ранее `contract.ts:841-847`).
5. `failContractCorruption()` (`runtime-host.ts:248-268`) → `invalid_native_event` → **`process.exit(1)`**.
Итог: обычная ошибка восстановления аудиоустройства убивает весь медиа-рантайм (микрофон + экран + камера + remote video) посреди звонка. Относится к **любому** `__`-префиксному пути, способному бросить.

**E2. [КРИТИЧНО] Пробы живости (1 с) против блокирующих операций (5–10 с) → рестарт хоста** — `runtime-supervisor.ts:398-405, 1030-1061` (`DEFAULT_PROBE_TIMEOUT_MS = 1000`), `:916-966` (`armRetirementWatchdog` шлёт `probeMicrophoneActor` через 1 с после connect/disconnect); проба попадает в тот же мэйлбокс (`media_runtime.cpp:263-267`); актор занят `startCapture`/`ensureCapture` (D10).
Смена/отвал/медленный USB-микрофон → проба таймаутит → `recycleHungAdapterIfCurrent('liveness_probe_failed')` → kill + restart всего медиа. Таймауты команд `configureMicrophone` 5 с / `setMicrophoneMuted` 2 с (`native-rtc-engine-adapter.ts:24, 22`) истекают раньше реальной смены устройства.

**E3. [КРИТИЧНО] `degraded` — билет в один конец** — `runtime-supervisor.ts:24-25` (3 рестарта / 60 с), `:734-744` (4-й сбой → circuit open → `degrade()`), `:228-237` (`start()` отклоняется), `:457-474` (`retry()`).
`retry()` **не вызывается нигде в продакшн-коде** (только `runtime-supervisor.test.ts:576`). После серии сбоев (которые E1+E2 отлично производят) весь нативный медиа-стек мёртв до перезапуска приложения, без UI-пути восстановления.

**E4. [ВЫСОКИЙ] `std::terminate` как штатная реакция на переполнение шины** — см. A4–A6; со стороны интеграции: подвисший JS-тред utility-хоста = крэш = рестарт = терминальный сбой звонка. Lifecycle-события при быстрых сменах устройств идут именно в control-полосу (512).

**E5. [СРЕДНИЙ] Восстановление после рестарта неполное** — `native-media-controller.ts:546-563` (восстанавливается только microphone preview, с тем же `sessionId`); `native-rtc-engine-adapter.ts:1012-1022` (звонок: один `terminalFailure` на `hostEpoch`, дальше — забота voice-сервиса); `:973-980` (сбрасываются `microphoneConfigKey`/`microphonePipelineWarm`, но не `microphoneAppliedConfigRevision`; метрики фильтруются по точному совпадению ревизии `:837` — рассинхрон тихо гасит индикатор «вы говорите»).

**E6. [СРЕДНИЙ] Shutdown: дедлайн меньше цепочки остановки** — `index.ts:83` (`APP_SHUTDOWN_TIMEOUT_MS = 5000`) против `stopMicrophonePreview` (5000) + `supervisor.shutdown()` (до 2 с + kill) = до 7 с. При закрытии во время звонка `app.quit()` наступает раньше graceful-остановки → LiveKit-треки не unpublish-атся; `shutdownAndWait` может быть прерван внутри 5-секундного `startCapture`.

**E7. [ВЫСОКИЙ] Диагностика недоступна там, где нужна** — `native-media-engine.ts:400-406` (нативные NDJSON-логи только при `SYRNIKE_NATIVE_MEDIA_DIAGNOSTICS === '1'`), `utility-adapter.ts:133` (`stdio: 'ignore'` — stderr нативного крэша не сохраняется, остаётся только exit code).
Сама система диагностики при этом хорошая: NDJSON тремя ролями с общим `runId` (`utility-adapter.ts:95-101`), классификация инцидентов (`diagnostic-incidents.ts:23-33`), смоук-тест проверяет (`smoke-utility-host.cjs:297-314`). Смоук **не** проверяет рестарт супервизором (`smoke-utility-host.cjs:229-233` — только факт выхода после `injectCrash`).

---

## 3. План исправлений

Принципы:
- **Сначала наблюдаемость, потом фиксы** — иначе не узнаем, что именно чиним и починили ли.
- **Штатное событие не должно быть смертельным.** Смерть процесса — только для реально неконсистентного состояния.
- **Ни одного блокирующего вызова без верхней границы времени** в capture-потоках и на актор-тредах.
- Control plane (`*PublicationController`, `GenerationFence`, `ActorMailbox`, `MediaOperation`) не переписываем — только точечные правки.

Каждая задача: **[что] → [файлы] → [критерий приёмки]**. Зависимости указаны; внутри фазы задачи параллелятся.

---

### Фаза 0 — Наблюдаемость (1–2 дня, делается ДО любых фиксов)

**0.1. Включить нативную диагностику по умолчанию.**
`native-media-engine.ts:400-406`: инвертировать флаг (выключение через `SYRNIKE_NATIVE_MEDIA_DIAGNOSTICS=0`), добавить ротацию/лимит размера NDJSON.
*Приёмка:* у свежеустановленного приложения после звонка есть NDJSON-логи всех трёх ролей с общим `runId`.

**0.2. Сохранять stderr/crash-выход utility-процесса.**
`utility-adapter.ts:133`: `stdio: 'ignore'` → pipe в файл диагностики (с ограничением объёма); на `exit` логировать code/signal + последние N КБ stderr в incident.
*Приёмка:* искусственный `std::terminate()` в хосте оставляет читаемый след (exit code + stderr) в diagnostic bundle.

**0.3. Счётчики-инциденты для гипотез аудита.**
Убедиться, что `adapter_recycled`, `liveness_probe_failed`, `native_contract_corruption`, `restart_aborted_circuit_open` попадают в телеметрию/бандл с контекстом (какая команда висела, сколько ждали). Добавить инцидент `screen_backend_restart` (для B2) и `camera_read_stall`.
*Приёмка:* по одному диагностическому бандлу можно сказать, какая из корневых причин (КП-1…КП-4) сработала.

**0.4. Смоук на рестарт супервизора.**
`smoke-utility-host.cjs`: сценарий `injectCrash` дополнить проверкой, что супервизор перезапустил хост и handshake прошёл повторно.
*Приёмка:* тест зелёный; падает при поломке рестарт-логики.

---

### Фаза 1 — Убрать казни за штатные ошибки (2–4 дня; закрывает КП-1, большинство «странных вылетов»)

**1.1. [E1] `reply` без `requestId` ≠ contract corruption.**
Вариант А (минимальный, рекомендуемый): `media_runtime.cpp:1221` — для команд без `request_id` эмитить не `failedReply`, а `runtimeError`/внутренний incident-event с контекстом. Вариант Б (защита в глубину, тоже сделать): `runtime-host.ts:270` + `contract.ts` — валидный `reply` без `requestId` логировать как аномалию и **игнорировать**, не убивая процесс.
*Приёмка:* юнит-тест `runtime-host` на `{ type:'reply', ok:false }` без `requestId` — процесс живёт; интеграционно: выдёргивание микрофона в звонке не убивает хост.

**1.2. [E1] Аудит всех `__`-внутренних команд на `throw`.**
Пройти обработчики `__microphoneEndpointChanged`, `__screenRetireDone`, `__screenTerminal` и остальные `__*` в `media_runtime.cpp` / актёрах: исключение из внутренней команды → incident + переход актора в fail-состояние, не исключение наружу. `microphone_actor.cpp:902-911` — убрать `throw;`.
*Приёмка:* grep по обработчикам: ни один внутренний путь не может произвести reply без requestId и не пробрасывает исключение в `commandLoop` без классификации.

**1.3. [A5] Исключение из JS-listener'а не убивает процесс.**
`node_event_sink.cpp:334-342` + `event_sink.hpp:96-105`: различать «JS бросил» (логировать, событие считать доставленным — оно дошло до колбэка) и «TSFN мёртв/переполнен». `terminate()` оставить только для последнего, и то см. 1.4.
*Приёмка:* тест: listener бросает — процесс живёт, ошибка в логе.

**1.4. [A6, E4] Переполнение control-полосы — backpressure, не смерть.**
`node_event_sink.cpp:387-393`, `sequenced_emitter.hpp:26-34`: для control-полосы — `BlockingCall` с таймаутом (или ограниченное ожидание + повтор); `terminate()` только по истечении длинного дедлайна (например 10 с) с диагностическим событием. Рассмотреть подъём ёмкости 512 → 2048.
*Приёмка:* стресс-тест: заморозка JS-треда на 5 с при потоке lifecycle-событий — процесс живёт, события доставлены после разморозки.

**1.5. [E3] Выход из `degraded`.**
`runtime-supervisor.ts`: (а) авто-`retry()` по таймеру с экспоненциальным backoff (например 30 с → 1 мин → 5 мин); (б) прокинуть в UI состояние degraded + действие «Перезапустить медиа» → `retry()`.
*Приёмка:* тест супервизора: после circuit open и таймера медиа восстанавливается без рестарта приложения.

**1.6. [E2] Развести пробы живости и блокирующие операции.** Два обязательных шага:
(а) `runtime-supervisor.ts:1030` — `DEFAULT_PROBE_TIMEOUT_MS` 1000 → ≥ максимальной легальной блокировки актора (пока ею остаётся 10 с — значит 12 с), либо проба учитывает «актор занят длинной операцией X» как здоровый ответ;
(б) `microphone_actor.cpp:651-668, 692-751` — вынести `startCapture`/`probeCaptureDevice`/откат с актор-треда на отдельный worker с постом результата обратно (по образцу attempt-потоков publication-контроллеров). После (б) вернуть таймаут пробы к 2–3 с.
*Приёмка:* интеграционный тест: смена микрофона на медленном (замоканном) устройстве — ни одного `liveness_probe_failed`, команды `configureMicrophone` укладываются в таймаут.

---

### Фаза 2 — Зависания: таймауты на всё (3–5 дней; закрывает hang'и приложения)

**2.1. [B1] Убрать `RequestAccessAsync().get()` из capture-потока.**
`screen_gpu_capture.cpp:70-88`: запросить доступ один раз при старте процесса (или лениво с таймаутом через `wait_for` на `IAsyncOperation`), результат кэшировать. Из `handleNoFrame`-рестарта вызов исключить полностью.
*Приёмка:* нигде в capture-потоке нет `.get()` без дедлайна; рестарт WGC-сессии не трогает WinRT-брокера.

**2.2. [C1] Камера: прерываемый `ReadSample`.**
Минимальный вариант до полного rewrite (фаза 4): watchdog-поток; если `ReadSample` не вернулся за N секунд — `IMFSourceReader::Flush(MF_SOURCE_READER_ALL_STREAMS)` + `IMFMediaSource::Shutdown()` для принудительного разрыва, поток добить с дедлайном.
`camera_actor.cpp:213, 177-180`: все `join()` → `join` с дедлайном; по истечении — detach + терминальный инцидент сессии (процесс переживёт, утечка потока фиксируется в диагностике).
*Приёмка:* тест с зависшим мок-ридером: `stopActive`/`shutdown` завершаются за < 3 с.

**2.3. [B14] RTP-статистика — вон из capture-loop.**
`screen_actor.cpp:511-529`: собирать на отдельном таймере/потоке, в capture-loop только читать атомарный снапшот.
*Приёмка:* в capture-loop нет `wait_for` > 5 мс; fps стабилен при сборе статистики.

**2.4. [B16] Диалог выбора источников не виснет.**
`display_sources.cpp:229-231`: `SendMessageTimeout(..., SMTO_ABORTIFHUNG | SMTO_BLOCK, 200, ...)`; fallback на иконку класса. `:104-142`: убрать `CAPTUREBLT` из тумбнейлов окон (или заменить на `PrintWindow(PW_RENDERFULLCONTENT)`).
*Приёмка:* зависшее тест-окно не блокирует `listDisplaySources`; перечисление 30 окон < 500 мс.

**2.5. [E6] Согласовать дедлайны shutdown.**
`index.ts:83` и цепочку `dispose → stopMicrophonePreview → supervisor.shutdown`: суммарный бюджет < `APP_SHUTDOWN_TIMEOUT_MS` (ужать внутренние таймауты или поднять внешний), шаги — параллелить где возможно.
*Приёмка:* закрытие приложения в активном звонке: graceful unpublish успевает, процесс выходит < 5 с.

**2.6. [A3] Дедлок `SequencedEmitter::close`.**
`sequenced_emitter.hpp:37-40`: не держать `mutex_` во время блокирующего `sink_->close()` — забрать sink под локом, закрывать вне лока; либо `waitForInFlightCallbacks` с дедлайном.
*Приёмка:* тест: JS-колбэк, синхронно зовущий `dispatch` во время shutdown, не дедлочит.

---

### Фаза 3 — Recovery экрана: один супервизор бэкенда (1–1.5 недели; закрывает КП-3)

Заменить три несогласованных механизма (`WgcGpuCapturer::handleNoFrame` 2 с / `DxgiFallbackPolicy` 3 recovery / `ScreenOutputStallDetector` + `restartCaptureAfterStall`) одной машиной состояний на уровне `MonitorGpuCapturer`/`ScreenActor`:

**3.1. Спроектировать `CaptureBackendSupervisor`.**
Состояния: `healthy` / `no_content` (нет изменений на экране — НЕ ошибка) / `degraded` (recoverable-сбои) / `reinitializing` / `failed`. Входы: результат capture, HRESULT-класс, время с последнего **успешного** `AcquireNextFrame`/`TryGetNextFrame`, признак secure desktop (`SwitchDesktop`-проба или `E_ACCESSDENIED`-класс), device-removed.
Правила:
- «нет кадров» ≠ «сломано»: рестарт сессии только при независимом признаке поломки; порог — десятки секунд, с экспоненциальным backoff [закрывает **B2**];
- watchdog и для DXGI-пути: нет успешного acquire N секунд + есть признак изменения экрана → переинициализация [закрывает **B3**];
- двусторонний fallback DXGI↔WGC с периодической попыткой возврата; device-removed → пересоздание D3D-девайса на обоих путях [закрывает **B4**];
- backoff на все реинициализации; никаких `D3D11CreateDevice` чаще, чем раз в X секунд [закрывает **B5**];
- secure desktop (UAC/lock) → состояние `no_content` с ретраем каждые ~200 мс, без fallback и без смерти [закрывает **B13**].
*Приёмка:* дизайн-док + таблица переходов, ревью команды.

**3.2. Реализация + выпиливание старых механизмов.**
`screen_gpu_capture.cpp` (`handleNoFrame`, `DxgiFallbackPolicy`, `MonitorGpuCapturer::switchToWgc`), `screen_actor.hpp` (`ScreenOutputStallDetector` — упростить до потребителя событий супервизора). Ядро (пулы, композитор, keyed mutex, NV12-путь) не трогать.
*Приёмка:* сценарные тесты (мок-бэкенды): статичный экран 60 с — ноль рестартов; TDR → восстановление < 5 с; UAC-промпт → пауза и возврат без смены бэкенда; полноэкранная игра → fallback и возврат.

**3.3. [B6] Возврат слота `GpuFramePool.discard` с ретраем.**
`screen_gpu_capture.cpp:454-464`: `AcquireSync(consumer, 0)` неуспешен → слот в список «на возврат», повторять в начале каждого `process()`; логировать. Счётчик доступных слотов — в телеметрию.
*Приёмка:* стресс-тест гонки с энкодером: пул не деградирует до перманентного `EncoderBackpressure`.

**3.4. [B7] Лизинг-таймаут превью-кадров.**
`screen_actor.cpp` / `GpuPreviewPool`: превью-кадру — дедлайн (например 5 с); по истечении слот принудительно возвращается, хэндл ревокируется; `preview_capturers_` чистится независимо от `previewFramesInFlight`.
*Приёмка:* kill renderer-процесса при активном превью → capturer освобождён < 10 с (проверка по счётчикам D3D-объектов в диагностике).

**3.5. [B8] Teardown capturer'а — вне `preview_mutex_` и вне актор-треда.**
Старый capturer вынимать под локом, разрушать в retire-потоке.
*Приёмка:* стресс stall-рестартов: `probeScreenActor` не рапортует `actor_unresponsive`.

**3.6. [B9, B10] Точечные правки контроллера.**
`screen_publication_controller.cpp:1112-1121`: проверять возврат `post_`, при отказе — прямой переход `finishRetire` по внутреннему таймеру (self-heal `retiring_`). `:1088-1094`: `retireResources` в terminal/disconnect-путях — noexcept-обёртка (третья отставка → форс-освобождение + incident, не `logic_error`).
*Приёмка:* существующие тесты `screen_publication_control_plane_test.cpp` + новые кейсы на переполненную control-очередь.

**3.7. [B11] Ранний `ReleaseFrame` DXGI.**
`screen_gpu_capture.cpp:1046-1060`: компоновать во «внутреннюю» текстуру → `ReleaseFrame` сразу → дальнейшие конверсии из копии.
*Приёмка:* время удержания кадра duplication < 2 мс (замер в бенчмарке `screen_streaming_benchmark.cpp`).

**3.8. [B12, A16] Убрать высокоприоритетный спин GPU.**
`d3d11_gpu_completion.hpp`: `GetData` с прогрессивным сном (yield → 1 мс sleep) либо `ID3D11Fence` + event (feature level позволяет); MMCSS оставить только капчер-потоку, не спин-ожиданиям. Commit-барьеры `while(!committed) yield()` (`voice_actor.cpp:86-88`, `remote_video_bridge.cpp:256, 364`, `camera_actor.cpp:85-87, 329-331`) → `condition_variable`.
*Приёмка:* профиль CPU при демонстрации 30 fps: capture-поток < 15 % ядра на референсной машине.

**3.9. [B15] Стабильные id мониторов.**
`display_sources.cpp` / `screen_capture_target.cpp`: id вида `screen:<DeviceID>` (из `DISPLAY_DEVICE`/`QueryDisplayConfig`), резолв через `MonitorFromRect` уже есть. Обратная совместимость со старым форматом на переходный период.
*Приёмка:* тест: смена порядка мониторов между list и start → захватывается выбранный.

**3.10. [B18] Мелочи.** Курсор: сбой `GetFramePointerShape` → пропустить отрисовку курсора, не убивать бэкенд (`screen_dxgi_compositor.cpp:284-294, 187-191`). `takePreviewFrame` после fallback — опрашивать активный бэкенд (`screen_gpu_capture.cpp:1503-1516`). `rtp_stall_reported` при неуспешном `post_` — ретраить (`screen_actor.cpp:732-735`). Удалить/перенести `screen_video_capture.cpp` в `benchmarks/`.

---

### Фаза 4 — Камера: rewrite capture-слоя (1 неделя; закрывает КП-4)

**4.1. Async-ридер.**
`camera_capture.cpp`: перейти на `MF_SOURCE_READER_ASYNC_CALLBACK` + `IMFSourceReaderCallback` (`OnReadSample`/`OnEvent`/`OnFlush`). Watchdog по времени последнего кадра; остановка через `Flush` + ожидание `OnFlush` с дедлайном; `IMFMediaSource::Shutdown` при зависании.
*Приёмка:* мок/реальный тест: отвал устройства в любом состоянии → терминальное событие сессии < 3 с, никаких вечных `join`.

**4.2. Отслеживание удаления устройства.**
`MEVideoCaptureDeviceRemoved` через `OnEvent` + (страховка) подписка на `WM_DEVICECHANGE`/CM_Register_Notification в отдельном потоке. Событие → терминал сессии с кодом `device_removed` (UI сможет предложить другую камеру).
*Приёмка:* физическое выдёргивание USB-камеры в звонке → аккуратный терминал, приложение живёт, повторный старт с другой камерой работает.

**4.3. [C2] Убрать сетевую публикацию из-под `publication_mutex_`.**
`camera_actor.cpp:300-321`: по образцу screen-контроллера — attempt-состояние + generation fence вместо удержания мьютекса через `publishVideoTrack`.
*Приёмка:* два быстрых connect подряд не дедлочат; `shutdown()` при зависшей публикации завершается по дедлайну.

**4.4. [C3] Честная negotiation + (опционально) GPU-путь.**
Минимум: ранжировать только реально поддерживаемые форматы устройства, запрошенный — только если поддержан; логировать выбранный нативный формат и фактический fps.
Опционально (отдельный milestone): `MF_SOURCE_READER_D3D_MANAGER` + NV12 → `D3D11H264VideoSource` (переиспользовать экранный путь), убрать RGB32 + memcpy.
*Приёмка:* MJPG-камера 1080p30: CPU-нагрузка падает измеримо; в логах — выбранный формат.

**4.5. [C4] Проверять `GetAllocatedString` и активацию устройства.**
*Приёмка:* при ошибке строки устройства — явная ошибка, а не первое попавшееся устройство.

---

### Фаза 5 — Аудио: качество и предсказуемость микрофона (1 неделя, параллелится с фазами 3–4)

**5.1. [D2] Роль устройства по умолчанию.**
`audio_devices.cpp:45, 228, 105`: использовать `eConsole` (или настройку «системный дефолт / коммуникационный»), `OnDefaultDeviceChanged` слушать обе роли и реагировать на релевантную.
*Приёмка:* смена «Устройства по умолчанию» в панели звука подхватывается без рестарта.

**5.2. [D1] Event-driven WASAPI.**
Капчер микрофона, echo-reference, screen loopback, рендер: `AUDCLNT_STREAMFLAGS_EVENTCALLBACK` + `SetEventHandle`, буфер 1 с → 2–4 периода; цикл — `WaitForMultipleObjects(event, stop_event)`. MMCSS остаётся осмысленным.
*Приёмка:* glitch-метрики (уже есть в telemetry) до/после на нагруженной машине; джиттер захвата падает.

**5.3. [D3] Обработка `DATA_DISCONTINUITY`.**
`microphone_actor.cpp:1076-1084`: по флагу — сброс `raw_frame`-накопителя + событие в телеметрию (по образцу `screen_audio_capture.cpp:256-258`).
*Приёмка:* юнит-тест на фазовый сдвиг после разрыва.

**5.4. [D4, D5] AEC-опора с фактического устройства вывода + измеряемая задержка.**
`microphone_echo_reference.cpp:141`: брать эндпоинт из `remote_audio_output` (`output_device_id_`), пересоздавать опору при `setOutputDevice`. `setStreamDelayMs`: оценка из `GetStreamLatency` + буферных позиций обоих клиентов вместо константы 50.
*Приёмка:* эхо-тест с выводом на не-дефолтное устройство: ERLE APM > 0 (метрика уже доступна из APM).

**5.5. [D6] Перезапуск echo-reference + честный статус в UI.**
Ретрай с backoff после `capture_failed`; прокинуть `MicrophoneAudioProcessorFrame::status` наружу вместо `processingMode(настройка)` (`microphone_publication_controller.cpp:29-31`).
*Приёмка:* убитая опора восстанавливается; UI показывает фактический режим.

**5.6. [D7] Не пересоздавать APM на лету.**
`microphone_audio_processor.cpp:36-49`: `ApplyConfig` для смены опций без пересоздания; пересоздание — только при смене sample rate/каналов.
*Приёмка:* моргание echo-reference не даёт всплеска CPU и сброса NS.

**5.7. [D8] Закрывать микрофон в простое.**
`microphone_actor.cpp`: `captureDemanded()` проверять при каждом изменении спроса (preview stop, disconnect, mute+нет preview); не требуется — `stopCapture()` с коротким «тёплым» грейсом (например 30 с) для быстрого повторного старта.
*Приёмка:* вне звонка индикатор микрофона Windows гаснет ≤ грейса.

**5.8. [D9] Категории аудио.**
`remote_audio_output.cpp:707`: `AudioCategory_GameChat` → пересмотреть (Media/Other + явное отключение ducking через `IAudioSessionControl2`/`AudioSessionDisableDucking`— решить с продуктом, есть ли причина для chat-категории). `microphone_actor.cpp:995-1011`: при `bypass == false` тоже вызывать `SetClientProperties` с осмысленной категорией.
*Приёмка:* воспроизведение музыки не приглушается при входе в звонок (на дефолтных настройках Windows).

**5.9. [D11, D12] Очереди и voice gate (низкий приоритет).**
Drop-oldest → drop-newest + маркер разрыва (ресинк по таймстампам); конфиг voice gate (attack/hold/release/lookahead) прокинуть в `RuntimeConfig` хотя бы для диагностики; lookahead не терять при `resetGateState`.

---

### Фаза 6 — C++ lifecycle и shutdown (3–5 дней; можно параллельно с фазой 5)

**6.1. [A1] Порядок разрушения `MediaRuntime::Implementation`.**
`media_runtime.cpp:1384-1396`: переставить члены (очереди и `emitter_` — раньше актёров по объявлению, т.е. позже по разрушению) + статический комментарий-инвариант; альтернатива — явный `destroyInReverse()`/`std::optional`-поля с упорядоченным сбросом в `~Implementation`. Добавить debug-assert «пост в закрытую очередь после начала разрушения».
*Приёмка:* ASAN-прогон (`build:asan` уже есть) сценария «shutdown во время активных сессий» чист.

**6.2. [A2] Симметричный shutdown акторов.**
`microphone_actor.cpp:456-462`: останавливать `endpoint_monitor_` в `shutdown()`. Ревизия остальных акторов на «создаётся в конструкторе — не останавливается в shutdown».
*Приёмка:* тест: endpoint-событие после `shutdown()` не постится; ASAN чист на «выдернуть устройство во время выхода».

**6.3. [A4] Гонка `dispatch`/`close`.**
Согласовать через `shared_mutex`/epoch: `dispatch` держит read-lock на «эмиттер открыт»; `close` берёт write-lock. Отказ emit после close → тихий drop + лог, не `terminate` (согласуется с 1.4).
*Приёмка:* стресс-тест dispatch во время shutdown (1000 итераций) без падений.

**6.4. [A7] Не разрушать Room под `mutex_`.**
`livekit_publication_client.cpp:970-993`: под локом — только `std::move(voice_room_)` в локальную переменную; teardown (`waitDisconnected`/`waitForCallbacks`) — вне лока; `waitForCallbacks` — с дедлайном (например 5 с) + incident при истечении.
*Приёмка:* reconnect-стресс (make-before-break × 50): JS-поток не блокируется > 50 мс (замер в тесте), voice-mailbox не переполняется.

**6.5. [A8] `LiveKitLease` переживает Room.**
`media_runtime.cpp`: lease — членом Implementation до `livekit_client_` (разрушается после него), либо `voice_.shutdown()` в «чистой» ветке обернуть try/catch как в catch-ветке `:1360`.
*Приёмка:* инъекция исключения в `voice_.shutdown()` → процесс завершается без обращения к мёртвому FFI.

**6.6. [A9–A12] Teardown аддона.**
`media_addon.cpp`: `asyncCleanup` — через `uv_async_send`-трэмплин на loop-поток; `ShutdownWorker::Execute` — try/catch с гарантированным `releaseRuntime`; `~MediaRuntimeBinding` — форс-`shutdownAndWait` + очистка `active_runtime`; `runtime_constructor` — per-env (`env.SetInstanceData`), продублировать в `hooks_addon.cpp:57`.
*Приёмка:* смоук:创建 runtime → уронить ссылку без shutdown → повторный `createMediaRuntime` работает; выгрузка окружения без крэша.

**6.7. [A13, A14] Мелочи.**
`released_frame_sequences_` — ограничить (LRU/кольцо) и валидировать вход из JS; lossy-методы `CoalescingEventLane` (`take`/`close`/`cancelScheduledCallback`) — удалить или сделать вызывающими `on_drop`.

**6.8. [E5] Интеграция после рестарта.**
`native-rtc-engine-adapter.ts:973-980`: сбрасывать `microphoneAppliedConfigRevision` при смене `hostEpoch`; ревизия логики восстановления (`native-media-controller.ts:546-563`) — новый `sessionId` после рестарта хоста, чтобы не столкнуться с generation fence.

---

### Порядок, зависимости, оценка

```
Фаза 0 (набл.)      ██ 1–2 дня          — первым, ни от чего не зависит
Фаза 1 (казни)      ████ 2–4 дня        — после 0; главный удар по вылетам
Фаза 2 (таймауты)   ████ 3–5 дней       — параллельно с 1 (разные файлы)
Фаза 3 (экран)      ████████ 1–1.5 нед  — после 2.1; крупнейший блок
Фаза 4 (камера)     ██████ ~1 нед       — после 2.2; параллельно с 3
Фаза 5 (аудио)      ██████ ~1 нед       — параллельно с 3–4
Фаза 6 (lifecycle)  ████ 3–5 дней       — параллельно с 5; ASAN обязателен
```
Суммарно ~3–4 недели командой из 2–3 человек. Фазы 0–2 дают основной прирост стабильности уже в первую неделю.

### Метрики успеха (снимать до фазы 0 как baseline и после каждой фазы)
1. Частота `adapter_recycled` / `native_contract_corruption` / exit≠0 utility-процесса на час звонка → цель: ~0 для штатных сценариев (смена устройств, UAC, статичный экран).
2. Частота рестартов WGC/DXGI-сессии на час демонстрации → цель: 0 на статичном экране.
3. P95 времени восстановления после TDR/`ACCESS_LOST` → цель: < 5 с, без терминала сессии.
4. Зависания на выходе (процессы, живущие > 10 с после quit) → цель: 0.
5. Жалобы «замёрзший экран» / «камера умерла» / «микрофон странный» в саппорте.

### Обязательный регресс-набор (дополнить существующие ctest/смоуки)
- Выдёргивание/втыкание микрофона, наушников, USB-камеры: в простое, в звонке, во время выхода.
- Смена системного дефолт-устройства (обе роли) во время звонка.
- UAC-промпт и lock screen во время демонстрации экрана.
- TDR (dxcap -forcetdr) во время демонстрации.
- Статичный экран 5 минут; свёрнутое захватываемое окно.
- Быстрый reconnect × 50 (make-before-break).
- Kill renderer-процесса при активном локальном превью.
- Закрытие приложения в активном звонке.
- ASAN-прогоны lifecycle-тестов (`build:asan` + `test:native:debug`).

---

## Приложение А. Что НЕ трогать (работает хорошо)
- `ActorMailbox` + коалесинг, `GenerationFence`, `MediaOperation`, `*PublicationController`-машины состояний (кроме точечных 3.6).
- Zero-copy NV12-путь экрана: `GpuFramePool`, keyed-mutex-протокол, `DxgiFrameCompositor` (курсор/поворот), связка с `D3D11H264VideoSource`.
- Изоляция в utility-процессе, верификация артефактов/контракта, allowlist env.
- Система `on_drop`/`RuntimeEventResourceGuard`/`ActorCommandResourceGuard`.
- Классификация HRESULT (`audio_failure.cpp`, разбор ACCESS_LOST/DEVICE_REMOVED).
- NDJSON-диагностика с общим `runId` (только включить по умолчанию — 0.1).

## Приложение Б. Ограничения аудита
- Код не собирался и не запускался; все выводы — из чтения исходников. Цепочка E1 (reply без requestId → exit) выведена по 5 файлам и проверяется юнит-тестом за час — сделать это первым действием фазы 1.
- `livekit_publication_client.cpp` (~5.3 тыс. строк) и `media_runtime.cpp` прочитаны не целиком — только пути, относящиеся к перечисленным сценариям.
- Вендорный LiveKit SDK (`vendor/`, FFI) не аудировался.
