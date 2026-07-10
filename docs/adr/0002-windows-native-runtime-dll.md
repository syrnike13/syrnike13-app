# ADR-0002 — Windows native runtime: DLL в изолированных utility hosts

- **Status:** Accepted
- **Date:** 2026-07-10
- **Related:** ADR-0001 (`VoiceIntentDirector` остаётся единственным владельцем
  voice intent)

## Контекст

Windows media, global hotkeys и overlay detection исполнялись тремя
собственными EXE. Electron main запускал их через `child_process`, отправлял
JSONL в stdin и угадывал владельца событий по процессу. Это давало аварийную
изоляцию, но делало interface transport-зависимым и размывало lifecycle между
Electron и EXE.

Media EXE дополнительно использовал process-global `g_running`, runtime config
и независимые вызовы `livekit::initialize/shutdown`. Warmup и publish могли
одновременно открыть два WASAPI capture path; microphone move был
break-before-make; terminal LiveKit disconnect и fatal screen capture не всегда
доходили до Electron. Большой Electron orchestrator одновременно владел IPC,
процессами, JSON parsing, sessions, diagnostics, recovery и picker state.

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
приходят typed events с `requestId`, `sessionId`, `generation` и `sequence`.
Lifecycle/error events не отбрасываются молча; saturation завершает utility host
и превращается supervisor'ом в явный `runtime_lost`.

### Instance-owned implementation

`MediaRuntime` владеет одной LiveKit lease и instance-owned actors. Каждый actor
сериализует свои команды, использует cooperative cancellation и проверяет
generation после asynchronous work. Shutdown сначала останавливает actors и
workers, затем комнаты, и только после этого освобождает LiveKit runtime.

Microphone warmup и publication используют один долгоживущий WASAPI/DSP
pipeline. Для make-before-break move один обработанный PCM frame временно
подаётся в отдельные room-owned `AudioSource`; candidate становится активным
только после подтверждённой публикации и проверки generation.

`ScreenActor` сохраняет preconnected room до start/cancel и превращает target
close, fatal capture, audio failure и terminal Room disconnect в явный terminal
event с unpublish и cleanup. Process-wide priority не меняется; используется
только MMCSS/thread priority.

### Electron ownership

`NativeRuntimeSupervisor` владеет utility process, handshake, request
correlation, timeouts, restart backoff и crash circuit. Media controller хранит
только актуальное execution state, необходимое для crash rehydration.

`VoiceIntentDirector`/executor по ADR-0001 остаётся единственным владельцем
desired/committed/phase/operation recency. Native modules не выбирают канал и не
восстанавливают session, уже отменённую более новой generation.

### Поставка и диагностика

Native resources упаковываются по manifest allowlist: две `.node`, две LiveKit
DLL и manifest с версиями и SHA-256. Wildcard-копирование `out/native` запрещено.
Release binaries подписываются; ABI/load smoke выполняется реальным Electron.

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
- Lifecycle, recency и recovery имеют locality в runtime/controller modules.
- Fake ChildProcess и JSON parser удаляются из interface и test surface.
- C++ core тестируется без Electron, а supervisor — через отдельный fake adapter.
- Mic move сохраняет capture/DSP и не обрывает старую публикацию до готовности
  новой.

**Отрицательные / риски:**

- Utility process остаётся отдельным процессом и требует Electron ABI smoke.
- Native actors и LiveKit teardown сложнее первоначального EXE lifecycle и
  требуют fault-injection/soak tests.
- Release зависит от Windows code-signing credentials и symbol pipeline.
- Постоянного EXE fallback нет; rollback выполняется новой подписанной версией.

## Отвергнутые альтернативы

- **DLL в Electron main** — отвергнуто из-за общего crash/hang domain.
- **Один utility host для всего native** — отвергнуто: media crash ломал бы
  hotkeys и overlay.
- **Оставить EXE как fallback** — отвергнуто: сохраняет два lifecycle и два
  transport interface, снижая locality и тестируемость.
- **Fake ChildProcess поверх addon** — отвергнуто: переносит старую сложность,
  а не создаёт deep typed interface.
