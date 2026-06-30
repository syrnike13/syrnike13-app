# ADR-0001 — VoiceIntentDirector: единый авторитет голосового интента

- **Status:** Accepted
- **Date:** 2026-06-29
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
   двигают `committed`. Две поверхности сопоставления схлопнуты в одну.
3. **Сериализованная очередь переходов.** Переходы исполняются **по одному**,
   через явную очередь шагов. Новый клик **обрезает хвост** очереди (coalesce):
   последняя цель всегда становится финальной. Шаг не стартует, пока предыдущий
   не достиг терминального состояния.
4. **Recency как локальный инвариант.** `operation_id` «текущий», только пока он
   в голове очереди. Каждый асинхронный side-effect (room teardown, publisher
   stop, gateway reply) проверяет recency **внутри** Director'а. Старый
   `operation_id` не может сдвинуть текущий интент. Это заменяет россыпь
   tombstone/ref guards одним инвариантом.
5. **Recovery внутри Director'а.** Сверка `committed`↔сервер (после WS-реконнекта
   или дрейфа) — ответственность Director'а (он владеет `committed`).
   Отдельного `runVoiceRecovery`-оркестратора нет; recovery = постановка
   корректирующего перехода в очередь.
6. **Director поглощает state-машину.** `voice-session-machine.ts` и
   `voice-session-controller.ts` удаляются; их фазовая модель переезжает внутрь
   Director'а.

### Контракт `move`

На клиенте `move(newChannel)` — **одна** операция. На бэкенд уходит единый
`VoiceStateUpdate{channel_id: newChannel, operation_id}`. Если у пользователя
уже есть активная голосовая сессия, бэкенд связывает новую операцию с
предыдущей через `replaces_operation_id` и при commit нового LiveKit join
сам завершает predecessor. То есть **hard-leave(old op) + join(new op)**
происходит под капотом серверного commit, а клиент не шлёт отдельный
`VoiceStateUpdate{channel_id: null}` для move.

### Hard-leave — fire-and-forget

Hard-leave остаётся только для явного выхода (`clear_intent`) и force-cleanup
сценариев. Director не использует hard-leave как обязательный под-шаг move:
скорость и детерминизм move даёт один join-запрос с server-side
`replaces_operation_id` fencing.

### Таймауты шагов

- Hard-leave: fire-and-forget, таймаута нет.
- Join: **15с** на `VoiceServerUpdate` (текущий баланс). При таймауте — rejoin с
  тем же `op_id`, без отката `desired`.
- Move: единый серверный запрос, таймаут 15с.
- Recovery подхватывает зависания.

### Native publishers (desktop)

На уровне LiveKit переподключить трек между комнатами **нельзя** (трек
принадлежит participant'у комнаты). НО нативный процесс уже умеет **менять
комнату** через `connect_microphone` stdin-команду, переиспользуя `AudioSource`,
capture-thread и DSP. Текущий полный рестарт при move — артефакт wiring'а в
Electron (`mediaStartSession` делает hard-kill активных mic-сессий), а не
ограничение LiveKit. Seamless-move для desktop — смена wiring'а (reconnect IPC +
стабильная сессия через move + опциональный preconnect новой комнаты), без
изменения LiveKit SDK.

## Последствия

**Положительные:**

- Гонки #1, #3, #4 убираются локализованно (recency внутри Director'а), а не
  россыпью guard'ов по шести файлам.
- Move становится детерминированным: `A→B→C` всегда заканчивается в `C`, без
  утечек комнат и без убийства базовой комнаты.
- Поверхность тестирования = интерфейс Director'а; гонки тестируются как
  юниты, без моков LiveKit+gateway.
- Desktop-move стабилизируется через seamless publisher swap.

**Отрицательные / риски:**

- Upfront-площадь: Director поглощает state-машину целиком → миграция затрагивает
  всех потребителей (`voice-provider.tsx` и далее). Требует поэтапного плана.
- Бэкенд-контракт `move` (hard-leave + join под капотом) — новая серверная
  логика; legacy-семантика остаётся fallback и усложняет reading, пока не
   атрофируется.
- Seamless native publisher swap требует нового IPC в Electron и стабильной
  identity/сессии через move — отдельная подзадача.

## Альтернативы, рассмотренные и отвергнутые

- **Оставить поверх machine** — отвергнуто: сохраняет два слоя и хрупкость.
- **Строгий leave→join с ожиданием коммита** — отвергнуто: +1 RTT на каждый
  move, противоречит цели «UX как Discord».
- **Move = два клиентских запроса** — отвергнуто: единый серверный `move`
   детерминированнее, клиент не оркестрирует под-шаги.
