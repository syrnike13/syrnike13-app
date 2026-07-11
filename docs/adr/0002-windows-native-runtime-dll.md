# ADR-0002 — Windows native runtime: DLL в изолированных utility hosts

- **Status:** Superseded by ADR-0003
- **Date:** 2026-07-10
- **Implementation amendment:** 2026-07-10 — declarative media reconciliation
  and actor-liveness semantics
- **Superseded:** 2026-07-11 — ADR-0003 сохраняет DLL utility isolation, но
  вводит одну native Room и три независимых host fault domains.
- **Related:** ADR-0001 (`VoiceIntentDirector` остаётся единственным владельцем
  voice intent)

## Контекст

Windows media, global hotkeys и overlay detection исполнялись тремя
собственными EXE. Electron main запускал их через `child_process`, отправлял
JSONL в stdin и угадывал владельца событий по процессу. Это давало аварийную
изоляцию, но делало interface transport-зависимым и размывало lifecycle между
Electron и EXE.

Media EXE дополнительно использовал process-global `g_running`, runtime config
и независимые вызовы `livekit::initialize/shutdown`. Warmup, preview и publish
могли одновременно открыть несколько WASAPI capture path вместо одного
канонического microphone pipeline; microphone move был break-before-make;
terminal LiveKit disconnect и fatal screen capture не всегда доходили до
Electron. Большой Electron orchestrator одновременно владел IPC, процессами,
JSON parsing, sessions, diagnostics, recovery и picker state.

Прямая загрузка DLL в Electron main отвергнута: access violation, deadlock или
долгий native join завершили бы или заморозили всё приложение.

## Решение

### Два DLL modules и два utility hosts

Windows runtime поставляется двумя PE DLL с Node-API расширением `.node`:

- `syrnike_media.node` — microphone, screen capture/audio, preview, device и
  source queries, LiveKit;
- `syrnike_hooks.node` — global hotkeys и foreground/overlay observation.

Каждая DLL загружается только внутри собственного Electron utility process.
Собственных runtime EXE, JSONL, stdin/stdout command transport и legacy EXE
fallback в конечной сборке нет. Installer и CI test executables не считаются
runtime helpers.

### Deep runtime interface

Оба native modules имеют один и тот же маленький interface:

```text
createRuntime(onEvent) -> { dispatch(command), shutdown() }
```

`dispatch` только валидирует и помещает typed command в bounded queue; connect,
enumeration и thread join никогда не выполняются на JS event loop. Результаты
приходят typed events с transport/execution identifiers и `sequence`.
`sessionId`/`generation` существуют только ниже Electron reconciliation seam;
renderer их не создаёт, не передаёт и не использует для publication
choreography. Lifecycle/error events не отбрасываются молча; saturation
завершает utility host и превращается supervisor'ом в явный `runtime_lost`.

Для microphone contract уточняется так: persistent **Microphone Pipeline**
существует независимо от конкретного publish lifecycle, preview и meter не
создают renderer-visible session identity. Renderer publication seam — один
immutable `LocalMediaIntent`; preview сохраняет отдельную внутреннюю revision.
Renderer получает identity-free preview lifecycle state. Публичный
`monitor`/preview pseudo-session запрещён.

### Instance-owned implementation

`MediaRuntime` владеет одной LiveKit lease, `ScreenActor`, `MicrophoneActor` и
render-only `PreviewActor`. `MicrophoneActor` реализует persistent
**Microphone Pipeline**: владеет выбранным input device, единственным WASAPI
capture path, DSP config, warm state и meter. Publish и `PreviewActor`
подписываются на pipeline как consumers и могут сосуществовать, но не открывают
параллельные capture path. Actors проверяют generation после asynchronous work;
microphone и screen publication controllers запускают каждый blocking LiveKit
lifecycle в отдельном bounded attempt worker, не на actor mailbox. Shutdown
сначала останавливает consumers/actors и workers, затем комнаты, и только после
этого освобождает LiveKit runtime, если SDK calls возвращаются.

Microphone warmup, preview и publication используют один долгоживущий
WASAPI/DSP pipeline. Для make-before-break move один обработанный PCM frame
временно подаётся в отдельные room-owned `AudioSource`; candidate становится
активным только после подтверждённой публикации и проверки generation.

При move native candidate подключается и получает publish acknowledgement по
prepared reservation до подключения browser Room. Только browser join может
финализировать backend operation и сделать predecessor stale. Если native
candidate не опубликован или superseded, browser Room не создаётся, а
финализированный predecessor остаётся rollback target.

Retirement worker владеет своим состоянием через shared ownership. Перед
уничтожением LiveKit Room runtime ждёт terminal disconnect, отсоединяет delegate
и дожидается выхода уже начавшихся SDK callbacks; asynchronous disconnect не
может пересечься с освобождением delegate/Room.

`ScreenActor` сохраняет preconnected room до start/cancel и превращает target
close, fatal capture, audio failure и terminal Room disconnect в явный terminal
event с unpublish и cleanup. Process-wide priority не меняется; используется
только MMCSS/thread priority.

### Electron ownership

`NativeRuntimeSupervisor` владеет utility process, handshake, request
correlation, restart backoff и crash circuit. Query timeout завершает request и
может запустить actor-specific liveness probe. Timeout mutating publication
имеет uncertain commit outcome, поэтому media host recycle'ится: сохранять его
означало бы допустить ghost publication. Failed probe и
process/transport/native-fatal evidence также приводят к recycle.

Publication capacity bounded: пока занятый candidate/retirement находится
внутри outer deadline, новая команда получает retryable `actor_busy` без нового
worker. После deadline actor/probe возвращает `actor_unresponsive`, supervisor
принудительно завершает media host и восстанавливает только актуальный desired
state.

`NativeMediaReconciler` атомарно принимает immutable `LocalMediaIntent`, владеет
desired/current/retry отдельно для microphone и screen и после restart
переигрывает только последние актуальные revisions. Media controller — его
execution adapter и не хранит mutable publication recovery snapshot.

`VoiceIntentDirector`/executor по ADR-0001 остаётся единственным владельцем
desired/committed/phase/operation recency. Native modules не выбирают канал и не
создают/supersede'ят operation. Renderer выводит один envelope с operation,
atomic `envelopeRevision` и независимыми kind revisions; observed native state
не меняет intent. `microphone: retain` сохраняет только уже подтверждённую
committed publication. Preview lifecycle не может подменять publication и не
моделируется как отдельная voice session.

## Поправка 2026-07-10 — декларативный seam и bounded native attempts

Файловая диагностика по умолчанию выключена во всех сборках и включается только
через `SYRNIKE_NATIVE_MEDIA_DIAGNOSTICS=1`. Она редактирует
token/URL/identity/device/source/window/path и удаляет локальные run-директории
старше 7 дней.

Императивные renderer calls (`start/reconnect/mute/stop session`) заменены на:

```text
applyLocalMediaIntent(intent) -> acceptance
onLocalMediaState(event)
```

Acceptance означает только валидацию и сохранение desired state в Electron, а
не завершённую LiveKit publication. Per-kind observed events fenced по
`operationId + revision`; native generation остаётся диагностикой реализации.

Supervisor различает query timeout, actor liveness и uncertain mutating commit:
query может быть проверен microphone/screen probe независимо, а timed-out
mutation требует нового host epoch и reconcile последнего desired state.

C++ publication attempt workers реализованы для microphone и screen. Они
сохраняют responsive mute/stop/terminal/probe mailbox и generation-fence late
completion, а bounded slots запрещают unbounded thread growth.

Оставшееся ограничение: публичные LiveKit SDK connect/publish/teardown calls
синхронны и не поддерживают cooperative cancellation. Cancel делает результат
stale, но не разматывает зависший SDK stack. После outer deadline runtime
возвращает `actor_unresponsive`, и единственный надёжный containment сейчас —
forced utility-host kill + supervisor restart. Это защищает Electron и другие
runtime, но не является graceful in-process teardown и требует отдельной
fault/soak квалификации.

### Поставка и диагностика

Native resources упаковываются по manifest allowlist: две `.node`, две LiveKit
DLL и manifest с версиями и SHA-256. Wildcard-копирование `out/native` запрещено.
ABI/load smoke выполняется реальным Electron. Authenticode не является release
gate, пока у проекта нет code-signing infrastructure; целостность staged native
artifacts проверяется через SHA-256 manifest и package verification.

Агрегированные SLO counters не содержат token, room URL, user ID, window title,
process path, device name или media content. Полные minidumps отправляются
только после явного согласия пользователя.

В desktop settings закреплены privacy defaults: анонимные allowlisted
native SLO counters/histograms включены, полные crash reports выключены.
Выключение counters применяется сразу и очищает неотправленную очередь в
памяти; изменение crash-report opt-in применяется при следующем запуске,
поскольку crash handler инициализируется один раз. Неотправленные локальные
dump-файлы старше 7 дней удаляются клиентом.

Backend принимает не более 100 событий за запрос, использует отдельный
rate-limit bucket и преобразует только фиксированные enum events в Prometheus
метрики. Произвольные labels и дополнительные JSON-поля отклоняются. Retention
Sentry в 30 дней и retention агрегированных Prometheus-метрик в 90 дней —
обязательные внешние настройки production infrastructure; приложение не может
гарантировать политики хранения внешних систем. Stable workflow блокируется
без Sentry DSN/symbol upload credentials, а фактические retention policies
проверяются release checklist инфраструктуры.

## Последствия

**Положительные:**

- Падение media runtime не завершает Electron main, renderer и hooks runtime.
- Voice recency имеет locality в Director, а publication desired/current/retry
  — в `NativeMediaReconciler`.
- Fake ChildProcess и JSON parser удаляются из interface и test surface.
- C++ core тестируется без Electron, а supervisor — через отдельный fake adapter.
- `LocalMediaIntent` скрывает internal session choreography и позволяет
  coalesce mute/stop/newer revisions на одном Electron seam.

**Отрицательные / риски:**

- Utility process остаётся отдельным процессом и требует Electron ABI smoke.
- Native attempts bounded, но synchronous SDK hang всё ещё освобождается через
  forced host termination; этот путь требует fault-injection/soak qualification.
- Неподписанные Windows artifacts вызывают предупреждение SmartScreen; Azure
  Trusted Signing остаётся опциональным будущим hardening, а не release gate.
- Постоянного EXE fallback нет; rollback выполняется новой версией с увеличенным
  `VERSION`.

## Отвергнутые альтернативы

- **DLL в Electron main** — отвергнуто из-за общего crash/hang domain.
- **Один utility host для всего native** — отвергнуто: media crash ломал бы
  hotkeys и overlay.
- **Оставить EXE как fallback** — отвергнуто: сохраняет два lifecycle и два
  transport interface, снижая locality и тестируемость.
- **Fake ChildProcess поверх addon** — отвергнуто: переносит старую сложность,
  а не создаёт deep typed interface.
