# ADR-0001 — VoiceIntentDirector: единый авторитет голосового интента

- **Status:** Accepted
- **Date:** 2026-06-29
- **Amended:** 2026-07-10 — prepared reservation/finalize и декларативный
  local-media seam
- **Supersedes:** неформальная модель, размазанная по
  `voice-session-machine.ts`, `voice-session-controller.ts`, `voice-join.ts`,
  `voice-provider.tsx`, `voice-gateway.ts`, `voice-local-event-guard.ts`,
  `voice-session-events.ts`.

## Контекст

Подключение к голосовым каналам и переключение между ними страдает двумя
болезнями:

1. **`VOICE_SERVER_UPDATE` ломается при быстром переключении** — клиент
   получает fail/таймаут при смене каналов.
2. **`move` нестабилен в desktop** — пользователя может «перекинуть не туда»,
   старая комната протекает, состояние залипает.

Корневая архитектурная причина: голосовой интент («в каком канале пользователь
хочет быть») размазан по семи модулям и управляется **двумя независимыми
поверхностями сопоставления** — `VoiceServerUpdate` (unicast, токен,
`op_id+channel`) и бродкаст `VoiceChannelJoin/Move` (строгая тройка
`active≈desired≈commit`). Плюс асинхронные side-effects раннера не защищены
recency единым образом — каждый call-site сам ставит guard'ы и tombstone-карты,
что делает систему shallow: интерфейс растёт, поведение концентрируется всё
меньше.

Найденные гонки (file:line до переработки):

- `voice-join.ts:246-262` — stale-таймаут старой операции зовёт
  `dropPreviousSession(X)` без recency-guard → убивает активную базовую комнату.
- `voice-provider.tsx:2312-2330` — `pendingReplacedVoiceRoomRef` штампуется
  уже-устаревшим `op_id` → `finalizePendingVoiceMove` не матчит → утечка комнаты
  при `A→B→C`.
- `voice-session-events.ts:94-104` — строгая тройка дропает коммит при 4-м
  клике → машина залипает в `waiting_server_commit`.
- `voice-gateway.ts:50,191` — один глобальный слот `pendingVoiceStateUpdate`,
  promise'ы живут до 15с, их `catch` разрушителен (см. первую гонку).

Deletion-test подтверждает, что текущие «точечные» модули
(`voice-local-event-guard.ts`, `pendingReplacedVoiceRoomRef`) shallow
относительно реальной ответственности — сохранить инвариант иммутабельного
интента — которая нигде не локализована. Удаление этих модулей не концентрирует
сложность, а размазывает её багами.

## Решение

Ввести единственный глубокий модуль **`VoiceIntentDirector`** (см. CONTEXT.md),
владеющий всем состоянием голосового интента за маленьким интерфейсом:

```ts
interface VoiceIntentDirector {
  join(channelId: string): void      // «хочу быть тут» (последний клик побеждает)
  leave(): void                       // «хочу выйти»
  move(channelId: string): void       // = join(другой канал) на клиенте,
                                       //   но единый move-запрос серверу

  readonly desired:   ChannelId | null
  readonly committed: ChannelId | null
  readonly phase: 'idle' | 'leaving' | 'joining' | 'connected'
  subscribe(fn): Unsubscribe
}
```

### Инварианты Director'а

1. **Единый авторитет интента.** `desired` — единственная правда о том, где
   пользователь хочет быть. Last-write-wins: новый клик переписывает `desired`.
2. **`committed` двигается только бродкастом.** `VoiceServerUpdate` несёт
   **только credentials** и не двигает интент. Только `VoiceChannelJoin/Move`
   двигают `committed`. Candidate становится `controlOperationId` только после
   server acceptance или typed rejection с authoritative operation;
   `gatewayDispatched` его не продвигает. Terminal leave/reset может очистить
   локальный control.
3. **Сериализованная очередь переходов.** Переходы исполняются **по одному**,
   через явную очередь шагов. Новый клик **обрезает хвост** очереди (coalesce):
   последняя цель всегда становится финальной. Шаг не стартует, пока предыдущий
   не достиг терминального состояния.
4. **Recency как локальный инвариант.** Только активная operation record
   Director'а считается текущей. Каждый асинхронный side-effect (room teardown,
   publisher stop, gateway reply) проверяет recency **внутри** Director'а.
   Старый `operation_id` не может сдвинуть текущий интент. Это заменяет россыпь
   tombstone/ref guards одним инвариантом.
5. **Recovery внутри Director'а.** Сверка `committed`↔сервер (после WS-реконнекта
   или дрейфа) — ответственность Director'а (он владеет `committed`).
   Отдельного `runVoiceRecovery`-оркестратора нет; recovery = постановка
   корректирующего перехода в очередь.
6. **Director поглощает state-машину.** `voice-session-machine.ts` и
   `voice-session-controller.ts` удаляются; их фазовая модель переезжает внутрь
   Director'а.

### Контракт `move`

На клиенте `move(newChannel)` — одна Director-owned операция. Запрос несёт
новый `operation_id` и ожидаемый текущий operation для compare-and-swap.
Бэкенд сначала создаёт **prepared reservation**, не меняя финализированную
сессию и roster. Reservation fenced одновременно по expected control и
expected finalized operation. После успешного reserve она становится prepared
terminal lease: downstream failure не откатывает authority; exact повтор того
же serialized reservation idempotent. Credentials выдаются только после
успешного reserve. Pending screen/camera flags сохраняются в reservation и
переносятся в finalized session; mutations обеих записей используют exact raw
CAS против stale webhook updates.

Новая операция становится `voice_current` лишь когда voice ingress получает
LiveKit join browser participant с этим exact `operation_id` в подписанном
token attribute. Finalize атомарно потребляет reservation и завершает
predecessor. Stale webhook не может финализировать или удалить более новую
операцию.

Возврат к уже подключённому A — отдельный
`retain_finalized(operation_id=A, expected_current_operation_id=B)`. Он не
создаёт A2 и не переписывает подписанный A transport. Backend проверяет
finalized A + prepared B, потребляет B, оставляет `voice_current=A` и сохраняет
TTL receipt `voice_retain_receipt:A:B = A`. Replay разрешён только при
отсутствующей reservation, exact current/raw A и этом receipt. Если B уже
finalized или CAS проигран, typed rejection сообщает authority B, retained
optimisation завершается и Director планирует обычный fresh join в A.

### Hard-leave — fire-and-forget

Hard-leave остаётся только для явного выхода и terminal cleanup. Director не
использует его как под-шаг move: пока candidate лишь reserved, predecessor
остаётся финализированным; переключение выполняет exact finalize. Disconnect
сначала CAS-удаляет prepared reservation, затем backend заново читает и удаляет
finalized session. Broadcast `VoiceChannelLeave` содержит finalized
`operation_id`; remote событие без него или для другой finalized operation
игнорируется. Явный local leave не обязан ждать broadcast для завершения
локального teardown.

### Таймауты шагов

- Hard-leave: fire-and-forget, таймаута нет.
- Join: **15с** на `VoiceServerUpdate` (текущий баланс). Timeout завершает
  текущий domain step с ошибкой; он не mint'ит следующую operation в tight
  retry loop. User/recovery может позже создать новый intent. Reliable transport
  вправе с паузой повторить тот же nonce/operation до ACK — это не новая
  domain operation.
- Move: reserve/credentials остаются одной Director operation, таймаут 15с.
- Recovery подхватывает зависания.

### Native publishers (desktop)

На уровне LiveKit переподключить трек между комнатами **нельзя** (трек
принадлежит participant'у комнаты). По ADR-0002 seamless move сохраняет один
WASAPI capture-thread и DSP pipeline, а обработанный PCM временно направляет в
отдельные room-owned `AudioSource`/track. Candidate room продвигается только
после подтверждённой публикации и recency-проверки. Полный рестарт при move —
артефакт старого imperative wiring, а не ограничение LiveKit SDK.

Renderer передаёт Electron один immutable `LocalMediaIntent`: `operationId`,
atomic `envelopeRevision` и независимые microphone/screen revisions. Он не
оркестрирует native `sessionId` или generation. Состояние `retain` разрешено
только для реально подтверждённой текущей microphone publication; candidate,
который ещё публикуется или уже упал, удерживать нельзя.

## Поправка 2026-07-10 — server-confirmed control и `retain_finalized`

Эта поправка уточняет исходное решение и заменяет локальный restore как
достаточный способ отмены move:

1. Только Director создаёт и supersede'ит `operation_id`. Credential refresh,
   screen/microphone recovery и Electron retry обязаны использовать текущую
   operation и не могут менять backend ownership.
2. `gatewayDispatched` фиксирует только transport handoff. `controlOperationId`
   продвигает candidate после credentials/commit acceptance либо корректируется
   typed rejection с authoritative operation. Timeout сам по себе authority не
   угадывает.
3. До gateway handoff возврат к retained source может быть локальной отменой.
   После handoff Director отправляет `retain_finalized(A, expected B)`, сохраняя
   исходную signed A operation, а не создавая A2.
4. Успешный retain атомарно потребляет exact B reservation и оставляет
   finalized A. Receipt `(A,B)` делает повтор идемпотентным. Conflict приводит
   к fresh reconnect с новой operation только после server rejection/commit.
5. Backend хранит prepared terminal lease отдельно от finalized session.
   Credentials принадлежат reservation, а broadcast commit рождается только
   после exact signed-operation finalize. Pending screen/camera flags переходят
   из reservation в session; mutations fenced exact raw CAS.
6. Director выводит `LocalMediaIntent`; Electron самостоятельно reconcile'ит
   per-kind revisions. Observed native state не может менять voice intent.
7. Browser transport использует identity
   `<user_id>:browser:<operation_id>` и обязан совпадать с signed operation
   token attribute. Поэтому stale cleanup удаляет exact transport, а не
   переиспользуемый `user_id`.
8. Любое terminal authority transition атомарно enqueue'ит immutable cleanup
   descriptor старой operation. LiveKit list/remove выполняет crond с bounded
   timeout и recheck; gateway/webhook не блокируются сетевым teardown.

Так ownership имеет locality в двух глубоких модулях: Director отвечает за
voice operation, а Electron reconciler — только за выполнение текущего
local-media desired state.

## Последствия

**Положительные:**

- Гонки #1, #3, #4 убираются локализованно (recency внутри Director'а), а не
  россыпью guard'ов по шести файлам.
- Backend control plane детерминированно fencing'ит `A→B→C`: stale reserve или
  finalize не может заменить последнюю Director operation.
- Поверхность тестирования = интерфейс Director'а; гонки тестируются как
  юниты, без моков LiveKit+gateway.
- Renderer/Electron publication seam сводится к одному immutable desired
  envelope вместо нескольких процедурных сессий.

**Отрицательные / риски:**

- Upfront-площадь: Director поглощает state-машину целиком → миграция затрагивает
  всех потребителей (`voice-provider.tsx` и далее). Требует поэтапного плана.
- Reservation и finalized session имеют разные TTL/cleanup invariants; любой
  cleanup обязан быть exact-operation scoped и durable до подтверждённого
  отсутствия transport.
- C++ attempt workers теперь bounded и не блокируют actor mailbox, но
  synchronous LiveKit SDK call всё ещё нельзя cooperatively cancel: потерянная
  capacity завершается `actor_unresponsive` и forced utility-host recycle.

## Альтернативы, рассмотренные и отвергнутые

- **Оставить поверх machine** — отвергнуто: сохраняет два слоя и хрупкость.
- **Строгий leave→join с ожиданием коммита** — отвергнуто: +1 RTT на каждый
  move, противоречит цели «UX как Discord».
- **Move = два клиентских запроса** — отвергнуто: единый join/replace reserve
  детерминированнее, клиент не оркестрирует leave→join под-шаги.
