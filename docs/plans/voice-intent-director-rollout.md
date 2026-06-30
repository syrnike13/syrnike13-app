# ПЛАН: VoiceIntentDirector — иммутабельная архитектура голосового интента

> Цель: UX уровня Discord. Две боли: (1) `VOICE_SERVER_UPDATE` ломается при
> быстром переключении каналов; (2) move нестабилен в desktop.
> Принцип: LiveKit и broadcast-коммит — единственный авторитет присутствия;
> Redis-кэш и клиентский интент — производные с recency-инвариантом.
>
> Связанные доки: `CONTEXT.md`, `docs/adr/0001-voice-intent-director.md`.

## Содержание

0. [Контракт на уровне всей системы (что двигает что)](#0-контракт)
1. [Фазирование и критерий готовности каждой фазы](#1-фазирование)
2. [Фаза A — ядро Director (pure state)](#фаза-a)
3. [Фаза B — Executor (владелец комнаты и переходов)](#фаза-b)
4. [Фаза C — извлечение модулей из voice-provider.tsx](#фаза-c)
5. [Фаза D — тонкий провайдер на executor](#фаза-d)
6. [Фаза E — удаление legacy-модулей](#фаза-e)
7. [Фаза F — native publishers в executor](#фаза-f)
8. [Фаза G — recovery внутри Director/executor](#фаза-g)
9. [Фаза H — backend Redis-self-healing (зомби)](#фаза-h)
10. [Полный список удаляемых файлов/символов](#9-список-удалений)
11. [Тест-матрица (что доказывает каждую боль закрытой)](#10-тест-матрица)
12. [Миграция данных/совместимость](#11-миграция)
13. [Риски и способы проверки без E2E](#12-риски)

---

<a id="0-контракт"></a>
## 0. Контракт на уровне всей системы

### Кто чем владеет (after)

| Слой | Владеет | НЕ владеет |
|---|---|---|
| **LiveKit** | фактом медиа-соединения (кто реально подключён) | — |
| **Backend Redis** | TTL-кэш membership + сессионные блобы | интентом (он производный от webhook) |
| **Backend webhook ingress** | эмиттом `VoiceChannelJoin/Move/Leave` бродкастов | — |
| **Client Director** | `desired` (последний клик), `committed`, очередью шагов, recency | комнатой, React-стейтом |
| **Client Executor** | LiveKit-комнатой, planned-disconnect, lifecycle переходов | React-стейтом, UI-рендерингом |
| **Client Provider** | React-стейтом UI (channelId в шапке, mic-кнопка, tiles), рендер snapshot | голосовой логикой |
| **Client native publishers** | mic/screen/camera LiveKit-участниками; вызв. executor'ом | решением «когда стартовать» |

### Контракт move (один запрос = leave+join под капотом)

Клиент → один `VoiceStateUpdate{channel_id: B, operation_id: op2}` при активной
сессии в A. Backend (УЖЕ делает это, проверено):
`create_voice_session` строит `replaces_operation_id`-цепочку → webhook
`participant_joined` для B → `commit_voice_session_join` заканчивает A,
эмитит **`VoiceChannelMove`**. **Backend Rust НЕ трогается.**

### Что двигает `committed`

- `VoiceServerUpdate` (unicast, токен) → **только credentials**, никогда не
  двигает `committed`.
- `VoiceChannelJoin`/`VoiceChannelMove` (broadcast) → **единственный** двигатель
  `committed`.
- `VoiceChannelLeave` (broadcast) → обнуляет `committed`.

### Recency-инвариант (едино для всей системы)

`operation_id` считается «текущим», только пока он в голове очереди Director'а.
Любой async side-effect (room teardown, publisher stop, gateway reply) проверяет
recency **внутри** executor'а перед мутацией. Старый op физически не может
сдвинуть `desired`/`committed`.

---

<a id="1-фазирование"></a>
## 1. Фазирование и критерий готовности

Каждая фаза — **компилируемый, тестируемый слайс**. Между фазами можно
смерджить/проверить. Критерий готовости фазы = `pnpm web:test` зелёный + `tsc
--noEmit` зелёный (за исключением pre-existing ошибок, см. §12).

| Фаза | Что | Риск | Зависит от |
|---|---|---|---|
| A | Director pure-state ядро + unit-тесты | 0 (изолировано) | — |
| B | Executor (комната+переходы) + unit-тесты | низкий | A |
| C | Извлечение модулей из provider (extraction-only) | низкий (механический) | — |
| D | Тонкий провайдер на executor | средний | B, C |
| E | Удаление machine/controller/guard | низкий | D |
| F | Native publishers → executor | высокий | D |
| G | Recovery → Director/executor | средний | D |
| H | Backend Redis self-healing | высокий (Rust, нужен Docker) | независимо |

**Порядок выполнения:** A → C (параллельно с B) → B → D → E → F → G. H независимо.

---

<a id="фаза-a"></a>
## 2. Фаза A — ядро Director (pure state)

### Файлы (новые)
- `apps/web/src/features/voice/voice-intent-director.ts`
- `apps/web/src/features/voice/voice-intent-director.test.ts`

### Типы (точные сигнатуры)

```ts
export type VoiceJoinReason = 'manual_join' | 'switch' | 'dm_answer' | 'rejoin'

export type VoiceDirectorPhase = 'idle' | 'leaving' | 'joining' | 'connected'

export type VoiceIntent =
  | { kind: 'none' }
  | { kind: 'channel'; channelId: string }

export type VoiceStep =
  | { kind: 'hard_leave'; operationId: string; channelId: string }
  | { kind: 'join'; operationId: string; channelId: string; reason: VoiceJoinReason }

export type VoiceDirectorState = {
  desired: VoiceIntent
  committed: string | null
  phase: VoiceDirectorPhase
  steps: VoiceStep[]
  activeOperationId: string | null
  supersededOperationIds: string[]
  lastError: string | null
}

export type VoiceDirectorEvent =
  | { type: 'intent'; channelId: string; reason: VoiceJoinReason }
  | { type: 'clear_intent' }
  | { type: 'commit'; operationId: string; channelId: string }
  | { type: 'leave_observed'; operationId: string | null }
  | { type: 'step_progress'; operationId: string; phase: VoiceDirectorPhase }
  | { type: 'step_awaiting_commit'; operationId: string }
  | { type: 'step_failed'; operationId: string; error: string }
  | { type: 'disconnected'; operationId: string; expected: boolean; error?: string }
  | { type: 'reset' }

export function createInitialDirectorState(): VoiceDirectorState
export function reduceDirector(
  state: VoiceDirectorState,
  event: VoiceDirectorEvent,
  createOperationId: () => string,
): VoiceDirectorState
```

### Инварианты (доказываются тестами)

1. **Last-write-wins:** `intent` переписывает `desired`; coalesce хвоста очереди.
2. **committed ← только commit-event:** `VoiceServerUpdate` не существует на этом
   уровне.
3. **Сериализация:** `steps` ≤ 2 (`[hard_leave?, join]`). Шаг не стартует, пока
   предыдущий не в терминале.
4. **Recency:** `activeOperationId === steps[0].operationId` (или null).
   `step_failed`/`commit` для чужого op игнорируются.

### Ключевая логика `replan(state, desired, reason)`

```
head = state.steps[0]               // исполняемый (сохраняем)
fromPosition = head ? positionAfter(head) : committed

steps = head ? [head] : []
if desired.channel != null:
    if fromPosition != null AND fromPosition != desired.channel:
        steps.push(hard_leave fromPosition)
    if fromPosition != desired.channel:
        steps.push(join desired.channel reason)
else if fromPosition != null:
    steps.push(hard_leave fromPosition)
return steps
```

`positionAfter(hard_leave) = null`, `positionAfter(join) = channelId`.

### Тесты (минимум)

- join-from-idle → 1 шаг join, active=op0, phase=joining
- intent-unchanged → no-op (=== identity)
- commit matching desired → committed, phase=connected, steps=[]
- commit irrelevant channel → ignored (immutability)
- move A→B (after commit A) → [hard_leave A, join B]
- **A→B→C** → [hard_leave A, join C]; join-B coalesced из плана
- stale commit для superseded op → desired не меняется
- clear_intent connected → [hard_leave]
- leave_observed для головного hard_leave → committed=null, phase=idle
- step_failed для current → desired сохранён, head снят, переплан
- step_failed для чужого op → ignored
- reset → initial

### Критерий готовости
`vitest run voice-intent-director.test.ts` → 13/13 зелёных. `tsc` чистый.
**Не подключается к прод-коду.**

---

<a id="фаза-b"></a>
## 3. Фаза B — Executor (владелец комнаты и переходов)

### Файлы (новые)
- `apps/web/src/features/voice/voice-intent-executor.ts`
- `apps/web/src/features/voice/voice-intent-executor.test.ts`

### Назначение
Plain-объект (НЕ React). Подписан на очередь Director'а. Исполняет каждый шаг с
recency-guard. Владеет `roomRef`. Публикует snapshot для провайдера.

### Типы

```ts
export type VoiceExecutorSnapshot = {
  activeOperationId: string | null
  room: Room | null
  committedChannelId: string | null
  phase: VoiceDirectorState['phase']
  lastError: string | null
}

export type VoiceExecutorDeps = {
  // Чтение внешнего состояния (provider живёт в React, executor читает через deps)
  getToken: () => string | undefined
  getLocalUserId: () => string | undefined
  isJoinBlocked: () => boolean
  getActiveSession: () => ActiveVoiceSessionSnapshot | null

  // I/O колбэки (тяжёлая логика живёт в provider/модулях, executor оркеструет)
  attachRoomHandlers: (room: Room) => void          // = attachAudio
  onRoomConnected: (room: Room, channelId: string) => void  // → finishLocalVoiceSetup
  onAbort: () => void                                // → abortJoinAttempt
  beginVisualTransition: (channelId: string) => void // optimistic UI
  clearVisualPresence: (channelId: string) => void
  onRoomChanged: (room: Room | null) => void         // provider syncs roomRef-mirror
  setLiveKitCredentials: (c: LiveKitNativeCredentials) => void
  setConnectionPhase: (p: VoiceConnectionPhase) => void
  createOperationId?: () => string
}

export function createVoiceIntentExecutor(deps: VoiceExecutorOptions): VoiceIntentExecutor
```

### Публичный API

```ts
interface VoiceIntentExecutor {
  getState(): VoiceDirectorState
  getSnapshot(): VoiceExecutorSnapshot
  getRoom(): Room | null
  subscribe(listener: (s: VoiceDirectorState) => void): () => void
  intent(channelId: string, reason: VoiceJoinReason): void
  clearIntent(): void
  observeCommit(operationId: string, channelId: string): void
  observeLeave(operationId: string | null): void
  observeDisconnected(operationId: string, expected: boolean, error?: string): void
  onRoomDisconnected(expected: boolean, error?: string): void
  reset(): void
  teardown(): Promise<void>
}
```

### Внутренний цикл исполнения

```
maybeExecute():
  if executing: return
  head = state.steps[0]
  if !head: snapshot.activeOperationId = null; return
  if state.activeOperationId != head.operationId: return
  if snapshot.activeOperationId == head.operationId AND snapshot.room: return  // уже исполняем
  executing = true
  try: await executeStep(head)
  finally: executing = false
  maybeExecute()  // пере-планирование могло поставить новую голову

executeStep(step):
  if step.hard_leave: executeHardLeave(op, channelId)
  else: executeJoin(op, channelId)

executeHardLeave(op, channelId):
  if !isCurrent(op): return
  requestVoiceLeave()                  // fire-and-forget
  deps.clearVisualPresence(channelId)
  // НЕ ждём коммит; leave_observed из бродкаста почистит committed

executeJoin(op, channelId):
  if !isCurrent(op): return
  try:
    result = await runner(channelId, { operationId: op })
    if !isCurrent(op): return          // supersede'нули
    if result === false: return
    dispatch('step_awaiting_commit', op)
  catch error:
    if !isCurrent(op): return
    dispatch('step_failed', op, message)
    // НЕ зовём dropPreviousSession (это была гонка #1). Director перепланирует.
```

### Runner (правка voice-join.ts)

`VoiceJoinRunnerDeps` теряет `requestJoinOperation`. `performVoiceJoin(channelId,
{ operationId })` — op приходит снаружи. Удаляется `voiceJoinReason()`.
`dropPreviousSession`/`restorePreviousSession` в deps становятся noop (Director
управляет откатом).

### Тесты (unit, mock I/O)
- join от idle → вызывается runner, по success — step_awaiting_commit
- hard_leave → вызывается requestVoiceLeave, НЕ ждёт
- supersede во время await runner → результат игнорируется (isCurrent false)
- failure → step_failed, desired сохранён, executor пере-планирует
- observeCommit для головного join → committed, phase=connected
- A→B→C: 3 intent подряд → финальный join только для C, промежуточные runner-вызовы
  прерываются по isCurrent

### Критерий готовости
Unit-тесты с моком runner + gateway зелёные. `tsc` чистый. **Не подключён к
provider.**

---

<a id="фаза-c"></a>
## 4. Фаза C — извлечение модулей из voice-provider.tsx (extraction-only)

**Принцип:** чистый extraction, без изменения поведения. Перенос функций в файлы
с явными deps. Провайдер импортирует их. Это разбиивает 3942-строчный файл на
тестируемые модули **до** того, как мы начнём менять логику.

### Целевые файлы (новые)

| Файл | Что переезжает | Из строк provider |
|---|---|---|
| `voice-room-audio.ts` | `attachAudio`, `playTrack`, room-event handlers, `cleanupAudio`, `applyRemoteAudio`, `audioSourceFromPublication`, `remoteAudioTrackId`, `localMicMediaStreamTrack` | ~2055–2292, 1018–1031 |
| `voice-local-setup.ts` | `finishLocalVoiceSetup`, `applyVoiceDevices`, `switchDeviceWithTimeout`, `syncMicFromRoom`, `restoreVoicePreferences`, `readCurrentVoiceFlags` | ~1376–1386, 1759–1864, 1068–1154 |
| `voice-native-media.ts` | `startNativeMicrophone`, `setNativeMicrophoneMuted`, `refreshNativeLiveKitCredentials`, `disconnectNativeMediaForHandoff`, native refs management | ~1156–1200, 1416–1558, 2018–2053 |
| `voice-stage-media-sync.ts` | `syncStageMediaItems`, `syncRoomParticipants`, `applyRemoteScreenParticipantSubscription`, stage refs helpers | ~791–1016 |
| `voice-recovery-runner.ts` | `runVoiceRecovery`, rejoin controller wiring, `decideVoiceRecoveryAction` usage | ~1560–1757 |
| `voice-screen-share.ts` | `startScreenShare`, `stopNativeScreenShare`, browser/native screen share, screen share debug sampling | ~2733+, 3700–3815 |
| `voice-stage-filters.ts` | `readStageMediaFilters`, `writeStageMediaFilters`, DEFAULT_STAGE_MEDIA_FILTERS, STAGE_MEDIA_FILTERS_STORAGE_KEY | 224–254 |
| `voice-token-helpers.ts` | `liveKitTokenExpMs`, `shouldRefreshLiveKitToken`, `isLiveKitTokenFailure` | 313–343 |

### Паттерн извлечения

Каждая функция получает **явный deps-объект** вместо замыкания над refs:

```ts
// voice-room-audio.ts
export type VoiceRoomAudioDeps = {
  getRoom: () => Room | null
  getUserId: () => string | undefined
  remoteAudioMixer: RemoteAudioMixer
  localSpeakingDetector: LocalSpeakingDetector
  isDeafened: () => boolean
  setParticipantCount: (n: number) => void
  onParticipantsChanged: () => void
  onRoomDisconnected: (expected: boolean) => void
  // ... etc
}

export function createVoiceRoomAudio(deps: VoiceRoomAudioDeps) {
  return {
    attachAudio(room: Room) { /* тело без изменений */ },
    cleanupAudio() { /* ... */ },
    applyRemoteAudio(deafened?: boolean) { /* ... */ },
  }
}
```

### Критерий готовости
`voice-provider.tsx` уменьшается до ~1500–1800 строк. `pnpm web:test` зелёный
(тесты провайдера, читающие исходник regex'ами, обновляются на новые имена
модулей). **Поведение идентично.**

---

<a id="фаза-d"></a>
## 5. Фаза D — тонкий провайдер на executor

### Что меняется в voice-provider.tsx

1. **Удалить:** `voiceSessionControllerRef`, `pendingReplacedVoiceRoomRef`,
   `joinInFlightRef`, `disconnectIntentRef`, `remoteVoiceSupersedeInFlightRef`,
   `voiceTransitionAttemptsRef`.
2. **Удалить функции (схлопываются в очередь Director'а):**
   - `finalizePendingVoiceMove`
   - `disconnectReplacedVoiceSession`
   - `disconnectSupersededTargetRoom`
   - `restorePendingVoiceMoveToSource`
   - `dropPreviousVoiceSession`
   - `restorePreviousVoiceSession`
3. **Добавить:** `voiceIntentExecutorRef` (создаётся once в `useRef`).
4. **`join(channelId)`** = `executor.intent(channelId, reason)` + rate-limit guard.
5. **`leave()`** = `executor.clearIntent()`.
6. **Gateway-subscription** (был ~35 строк, 2 поверхности) → 3 строки:
   ```ts
   eventsGateway.subscribeEvents((event) => {
     if (event.type === 'VoiceChannelJoin' || event.type === 'VoiceChannelMove') {
       if (voiceEventUserId(event) === auth.user?._id)
         executor.observeCommit(event.operation_id, event.to ?? event.id)
     } else if (event.type === 'VoiceChannelLeave') {
       if (event.user === auth.user?._id) executor.observeLeave(event.operation_id)
     }
   })
   ```
7. **Executor-deps wiring:** provider передаёт I/O-колбэки
   (`attachAudio`, `finishLocalVoiceSetup`, `setLiveKitCredentials`, etc.) в
   `createVoiceIntentExecutor`.
8. **Snapshot → React:** provider подписывается на executor, mirror'ит
   `snapshot.committedChannelId` → `channelId`, `snapshot.phase` →
   `status`/`connectionPhase`.
9. **`roomRef`** = `executor.getRoom()` (provider читает через геттер, не хранит
   отдельный ref; либо mirror в ref для useInside-callbacks).

### roomRef ownership
`roomRef` **переезжать в executor** не может (слишком много callback'ов в
attachAudio/finishLocal ссылаются на него). Решение: executor — единственный,
кто **присваивает** комнату (`setActiveRoom` через runner), провайдер имеет
`getRoom()`. Planned-disconnect (`disconnectIntentRef`) **уничтожается** —
плановость определяется **типом шага** в очереди Director'а.

### Тесты
- Обновить regex-тесты `voice-join.test.ts` (тесты, читавшие
  `pendingReplacedVoiceRoomRef`/`controller.handleServerCommitObserved`,
  заменяются на тесты executor'а из Фазы B).
- Добавить интеграционный тест: provider + executor + mock gateway →
  A→B→C заканчивается в C.

### Критерий готовости
`tsc` чистый. `pnpm web:test` зелёный. **Ручная проверка у пользователя:**
быстрое переключение A→B→C, move в desktop, leave, reconnect.

---

<a id="фаза-e"></a>
## 6. Фаза E — удаление legacy-модулей

### Удаляемые файлы
- `apps/web/src/features/voice/voice-session-machine.ts`
- `apps/web/src/features/voice/voice-session-machine.test.ts`
- `apps/web/src/features/voice/voice-session-controller.ts`
- `apps/web/src/features/voice/voice-session-events.ts` (логика переезжает в
  executor gateway-mapping, ~3 строки)
- `apps/web/src/features/voice/voice-session-events.test.ts`
- `apps/web/src/features/voice/voice-local-event-guard.ts` (tombstone больше не
  нужен — recency Director'а заменяет)

### Удаляемые импорты из voice-provider.tsx
- `createVoiceSessionController`
- `localVoiceSupersedeFromGatewayEvent`, `voiceCommitFromGatewayEvent`,
  `voiceCommitOperationIdToObserve`
- `rememberCanceledVoiceOperation`, `resetLocalVoiceEventGuard`,
  `setLocalVoiceEventUserId`, `shouldIgnoreVoiceGatewayEvent`

### Критерий готовости
`tsc` чистый (нет dangling imports). `pnpm web:test` зелёный.

---

<a id="фаза-f"></a>
## 7. Фаза F — native publishers в executor (опционально, высокий риск)

### Контекст (найдено агентом)
Native publisher (`mic/screen/camera`) — отдельный LiveKit-участник с identity
`<uid>:desktop-native:<kind>-N`. **Трек нельзя переподключить между комнатами**
на уровне LiveKit (трек принадлежит participant'у комнаты). НО нативный процесс
уже умеет менять комнату через `connect_microphone` stdin-команду, переиспользуя
`AudioSource`/capture-thread/DSP. Полный рестарт при move — артефакт wiring'а в
Electron (`mediaStartSession` hard-kills активные mic-сессии), не ограничение
LiveKit.

### Что меняется
1. Native media refs (`nativeMicrophoneRef`, generations, etc.) переезжат в
   executor (или в `voice-native-media.ts`, вызываемый executor'ом).
2. `disconnectNativeMediaForHandoff` → executor зовёт на hard_leave-шаге.
3. **Seamless move (desktop):** новый IPC `mediaReconnectMicrophoneSession` в
   Electron `native-media-engine.ts` (вместо `stopActiveMicrophoneSessions` +
   respawn) → пишет `connect_microphone` в существующий helper stdin. Стабильная
   identity/сессия через move. Опциональный preconnect новой комнаты.

### Файлы
- `apps/web/src/features/voice/voice-native-media.ts` (из Фазы C)
- `apps/desktop/src/main/native-media-engine.ts:2507-2508` (relax hard-kill gate)
- `apps/desktop/src/main/native-media-engine.ts` (новый IPC reconnect)
- `apps/desktop/native/native-voice-win/src/microphone_publisher.cpp:486-491`
  (уже поддерживает `connect_microphone`)

### Критерий готовости
Ручная проверка: move в desktop без паузы медиа, без двойных publisher'ов.
**Требует desktop-сборки.**

---

<a id="фаза-g"></a>
## 8. Фаза G — recovery внутри Director/executor

### Что меняется
`runVoiceRecovery` (отдельный orchestrator в provider) **переезжает в
executor** как метод `reconcileWithServer()`:
- На gateway `connected` или по таймеру — executor сверяет `committed` с
  `syncStore.voiceParticipants` (server view).
- Если дрейф → enqueue corrective step (`intent(desiredChannel)` или
  `clearIntent`).
- `voiceRejoinRef` остаётся как backoff-механизм для rejoin, но решение
  принимает executor.

### Критерий готовости
Тест: simulated gateway reconnect с дрейфом → executor корректирует.

---

<a id="фаза-h"></a>
## 9. Фаза H — backend Redis self-healing (зомби, независимо)

### Корневой дефект
`voice_channel_members:{ch}`, `voice_current:{user}` — **без TTL**. Чистятся
только успешным webhook'ом или reconcile. `voice_session:{op}` — TTL 120с, но
протухает для тихих участников. Reconcile `get_voice_participant_reconciliation`
`Ok(None)` на «нет node»/`list_room_participants` error — silent skip.

### Решение (см. ранее обсуждение, вариант 2+3)
1. **TTL на все membership-ключи** (~30с): `voice_current`, `voice_channel_members`,
   `voice_active_channels`, `voice_channel_node`, `voice_room_session`. Lua-скрипты
   `COMMIT_VOICE_SESSION_JOIN`, `CREATE_VOICE_SESSION` и др. — `SETEX`/`EXPIRE`.
2. **Heartbeat через reconcile:** crond каждые 5с (уже есть) после
   `list_room_participants` **продлевает TTL** подтверждённых участников + блоба.
3. **Reconcile = авторитетный вердикт, без silent-skip:**
   - `Ok(Some(participants))` → продлить подтверждённых, вычистить stale.
   - `Ok(None)` (Twirp NOT_FOUND, комната мертва) → вычистить **всех**
     redis-members.
   - `Err` (сеть/лаг) → skip, ретраить (не эвиктить живых).

### Файлы (Rust)
- `services/backend/crates/core/database/src/voice/session.rs` (Lua-скрипты
  `COMMIT_VOICE_SESSION_JOIN`, `CREATE_VOICE_SESSION`, `SAVE_CURRENT_VOICE_SESSION`,
  TTL).
- `services/backend/crates/core/database/src/voice/mod.rs:688-737`
  (`get_voice_participant_reconciliation` — три вердикта + heartbeat).
- `services/backend/crates/daemons/crond/src/tasks/voice_calls.rs` (sweep).

### Критерий готовости
`pnpm backend:check` (нужен Docker + Rust 1.92). Тест: пустой мёртвый канал с
зомби → crond вычищает. **Требует серверной проверки.**

---

<a id="9-список-удалений"></a>
## 10. Полный список удаляемых файлов/символов

### Файлы
- `voice-session-machine.ts` + `.test.ts`
- `voice-session-controller.ts`
- `voice-session-events.ts` + `.test.ts`
- `voice-local-event-guard.ts`

### Символы в voice-provider.tsx
- `voiceSessionControllerRef`
- `pendingReplacedVoiceRoomRef`
- `joinInFlightRef`
- `disconnectIntentRef` (плановость = тип шага)
- `remoteVoiceSupersedeInFlightRef`
- `voiceTransitionAttemptsRef` (или переезжает в rate-limit модуль)
- `finalizePendingVoiceMove`
- `disconnectReplacedVoiceSession`
- `disconnectSupersededTargetRoom`
- `restorePendingVoiceMoveToSource`
- `dropPreviousVoiceSession`
- `restorePreviousVoiceSession`
- `disconnectPendingReplacedVoiceRoom`
- импорты `createVoiceSessionController`,
  `localVoiceSupersedeFromGatewayEvent`, `voiceCommitFromGatewayEvent`,
  `voiceCommitOperationIdToObserve`, все `*voice-local-event-guard*`

###净 эффект
~300 строк move-спагетти из провайдера схлопываются в `reduceDirector` (~200
строк pure state) + `maybeExecute` (~80 строк в executor). Director + executor =
**единственный авторитет**, тестируемый изолированно.

---

<a id="10-тест-матрица"></a>
## 11. Тест-матрица (доказывает боли закрытыми)

| Боль | Тест | Фаза |
|---|---|---|
| #1 VOICE_SERVER_UPDATE при быстром A→B→C | director: A→B→C → plan=[leave A, join C]; executor: промежуточные runner-вызовы прерываются по isCurrent | A, B |
| Stale catch → dropPreviousSession убивает базу | executor: catch не зовёт dropPreviousSession; Director перепланирует | B |
| Зомби в сайдбаре (пустой канал) | backend: crond reconciles dead room → all members evicted | H |
| Move в desktop нестабилен | manual: move без двойных publisher'ов, без паузы медиа | F |
| Две поверхности сопоставления | director: committed двигается только commit-event; VoiceServerUpdate не существует на уровне Director | A |
| Recovery после реконнекта | executor.reconcileWithServer корректирует дрейф | G |

---

<a id="11-миграция"></a>
## 12. Миграция / совместимость

- **Backend:** без изменений (контракт move уже удовлетворяет). Фаза H
  опциональна и независима.
- **Client:** legacy state-machine удаляется полностью (Фаза E). Никакого
  сосуществования старого/нового — ADR требует единственного авторитета.
- **Wire-протокол:** без изменений (`VoiceStateUpdate`, `VoiceServerUpdate`,
  `VoiceChannelJoin/Move/Leave` те же).
- **Native desktop (Фаза F):** новый IPC опционален; без него move работает
  через stop+start (как сейчас), просто детерминированнее.

---

<a id="12-риски"></a>
## 13. Риски и способы проверки без E2E

| Риск | Где | Проверка без E2E |
|---|---|---|
| Native publisher timing regression | Фаза F | изолировать в voice-native-media.ts с unit-тестами; manual на desktop-сборке |
| Recovery регрессия после реконнекта | Фаза G | mock gateway-state-transitions в unit-тестах executor'а |
| React batching нарушен при snapshot-mirroring | Фаза D | отдельный интеграционный тест provider+executor с fake gateway |
| Pre-existing tsc errors маскируют новые | все | `tsc` baseline до начала (зафиксировать pre-existing: NativeScreenShareSession props, RemoteTrackPublication.sid) |
| Big-bang D+E ломает тонкое move-поведение | D, E | regex-тесты voice-join.test.ts переписать на executor-контракт ДО удаления legacy |

### Pre-existing tsc errors (зафиксировать как baseline)
- `voice-provider.tsx:273` — `RemoteTrackPublication.sid`
- `voice-provider.tsx:294, 2128` — `NativeScreenState.publicationSid`
- `voice-provider.tsx:3168-3172` — `NativeScreenShareSession.{width,height,fps,bitrate,audio}`
- `voice-publication-observer.ts:23` — `RemoteTrackPublication.sid`

Эти **не относятся** к voice-intent работе и не должны чиниться в этом
rollout'е.

---

## Сводка объёма

| Фаза | Новые/изменённые файлы | Строк кода (примерно) | Риск |
|---|---|---|---|
| A | 2 новых | ~400 | 0 |
| B | 2 новых + правка voice-join.ts | ~350 | низкий |
| C | 8 новых (extraction) | ~2000 (перемещение) | низкий |
| D | 1 переписанный (provider) | ~−300 (net) | средний |
| E | 6 удалённых + правка импортов | ~−500 | низкий |
| F | 3 изменённых | ~200 | высокий |
| G | 1 изменённый | ~150 | средний |
| H | 3 Rust-файла | ~150 | высокий (Docker) |

**Минимальный жизнеспособный набор, закрывающий обе боли:** A + B + D + E.
**Полная «надёжная как камень» система:** + F + G + H.
