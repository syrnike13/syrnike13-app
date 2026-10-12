# Накопительная деградация VoiceStage у зрителей

Дата: 10 августа 2026 года.

## Итог

Проблема частично связана с ранее исправленной деградацией screen share, но это
не одна и та же причина.

Предыдущее исправление закрывало зависание native shared-texture presentation,
retained GPU references, publisher stalls и аудиоочереди. Новое исследование
нашло дополнительную нагрузку уже внутри renderer/React VoiceStage:

1. VoiceProvider и VoiceStage пересобирались на несвязанные gateway updates,
   потому что selector участников каждый раз возвращал новый массив;
2. одинаковые `ResizeObserver` callbacks создавали новые state objects и
   лишние React renders;
3. изменение числа колонок переносило media tiles между row-компонентами,
   поэтому React unmount/mount-ил video/canvas consumers;
4. удалённый canvas не обнулял backing store;
5. маленький filmstrip canvas сохранял исходное разрешение стрима, включая 4K;
6. свёрнутый filmstrip продолжал держать и перерисовывать все media consumers;
7. remote canvas attach/detach уведомлял весь VoiceProvider, хотя его stage
   snapshot от consumer count не зависит.

Это сочетание не удерживало бесконечную очередь `VideoFrame`: registry по-прежнему
хранит максимум один pending frame на track. Но оно создавало:

- повторный mount/unmount тяжёлых media surfaces;
- задержанное освобождение canvas/GPU backing stores;
- лишние полные React passes;
- полноразмерное копирование каждого кадра в маленькие thumbnails;
- вытеснение pending frames, когда renderer не успевал дойти до
  `requestAnimationFrame`.

## Что исправлено

### Стабильные voice selectors

`useSyncStore` получил optional equality comparator. Для списков voice
participants используется сравнение по длине и identity элементов.

Production paths:

- `apps/web/src/features/sync/sync-store.ts`
- `apps/web/src/features/sync/voice-selectors.ts`
- `apps/web/src/features/voice/voice-provider.tsx`
- `apps/web/src/components/voice/voice-stage-view.tsx`

Несвязанное обновление чата или другого sync state больше не заставляет
VoiceProvider пересобирать stage только из-за нового array object.

### ResizeObserver без повторных одинаковых state updates

Grid и focus hooks теперь возвращают предыдущий size object, если целые width и
height не изменились.

Production paths:

- `apps/web/src/features/voice/use-voice-stage-grid-layout.ts`
- `apps/web/src/features/voice/use-voice-stage-focus-sizing.ts`

Два отдельных теста подают по 1000 одинаковых callbacks и проверяют отсутствие
дополнительных renders.

### Стабильная DOM-топология grid

Grid больше не создаёт отдельный React parent на каждый вычисленный ряд.
Плитки находятся под одним flex-wrap parent и сохраняют стабильный `key`.

До исправления переход, например, с двух на три колонки переносил часть плиток
между разными parent nodes. Для React это был unmount старого media tile и mount
нового, даже если `item.id` не менялся.

Теперь тест 200 раз переключает размеры между разными column layouts и
проверяет, что каждый media consumer смонтирован один раз и ни разу не
размонтирован.

Production path:

- `apps/web/src/components/voice/voice-stage-grid.tsx`

### Bounded canvas backing store

Native canvas теперь выбирает backing resolution по фактическому CSS-размеру
плитки, `devicePixelRatio`, исходному aspect ratio и режиму `contain/cover`.
Разрешение никогда не повышается выше source resolution.

Пример для 4K `3840×2160` screen share:

```text
Раньше, thumbnail 320×180:
  canvas backing = 3840×2160 = 8 294 400 pixels ≈ 31.6 MiB RGBA

Теперь при DPR=1:
  canvas backing = 320×180 = 57 600 pixels ≈ 225 KiB RGBA
```

Это приблизительно в 144 раза меньше pixels на один thumbnail. При DPR=2
backing будет `640×360`, всё ещё в 36 раз меньше 4K.

При unmount backing store явно сбрасывается в `0×0`.

Production paths:

- `apps/web/src/features/voice/native-video-registry.ts`
- `apps/web/src/components/voice/voice-stage-video.tsx`

### Свёрнутый filmstrip освобождает media

Во время 200-миллисекундной collapse-анимации filmstrip остаётся видимым.
После окончания анимации его media tiles unmount-ятся. При раскрытии они
mount-ятся до открытия панели.

Это прекращает скрытую отрисовку всех демонстраций, когда пользователь свернул
список участников.

Production path:

- `apps/web/src/components/voice/voice-stage-focus-stage.tsx`

### Remote consumer lifecycle не пересобирает VoiceProvider

Attach/detach удалённого canvas больше не вызывает registry notification,
которая пересоздавала `nativeVideoTracks`, `stageMediaItems` и stage context.

Notification сохранён для local screen preview: его consumer count реально
управляет native preview demand.

## Перезапускается ли стрим

Нет. Эти изменения не republish-ят stream и не переподключают voice room.

- изменение размера grid теперь вообще не remount-ит media consumer;
- collapse filmstrip и переход focus/grid могут detach/attach только локальный
  presentation consumer;
- native track adapter и RTC publication при этом остаются теми же;
- у LiveKit не пересоздаётся publication, publisher или room;
- у native viewer не меняется screen generation.

То есть это аналог отключения одного экрана от уже идущего декодера и
подключения другого canvas, а не перезапуск самой трансляции.

Отдельный recovery из предыдущего исправления может перезапросить remote demand
или reload-нуть renderer только при подтверждённом presentation stall. Publisher
republish происходит только при отдельном encoder/RTP stall.

## Откуда берутся «мёртвые» кадры

Теперь отчёт разделяет разные классы drops:

| Метрика | Значение |
| --- | --- |
| `framesDropped` из WebRTC | drop внутри WebRTC receive/decode pipeline |
| `rejectedFrames` main bridge | Electron/shared-texture bridge отказался принять кадр, например из-за retained budget |
| `rendererFramesSuperseded` | новый валидный frame пришёл до rAF и заменил старый pending frame |
| `rendererFramesDroppedNoConsumer` | frame намеренно закрыт, потому что ни одна tile его не показывает |
| `rendererFramesDroppedHidden` | frame намеренно закрыт в hidden document |
| `rendererFramesDroppedStale` | frame имеет старый sequence/generation |
| `rendererDrawFailures` | `drawImage` завершился исключением |

Большое `rendererFramesSuperseded` означает не накопление тысяч живых frames.
Registry удерживает один pending frame и немедленно закрывает заменённый. Это
сигнал, что renderer/main thread не успевает рисовать в cadence входящего
потока.

Например:

```text
rendererFramesReceived = 12 000
rendererFramesDrawn = 8 400
rendererFramesSuperseded = 3 500
rendererFramesDroppedNoConsumer = 75
```

Здесь 3500 кадров не утекли. Они были закрыты latest-frame policy, потому что
между двумя animation frames приходило больше одного кадра. После текущих
исправлений главные локальные причины такого отставания — remount churn и
полноразмерные thumbnail canvases — устранены.

## Метрики и автоматические отчёты

В каждый native screen snapshot теперь входят:

- received/drawn/superseded/no-consumer/hidden/stale frames;
- draw failures;
- canvas attach/detach totals;
- active consumers;
- суммарные backing-store pixels;
- frame width/height;
- возраст последнего полученного и нарисованного frame;
- presentation reset и renderer epoch changes.

Из cumulative counters вычисляются interval rates:

- `rendererFramesDroppedPercent`;
- `rendererFramesDroppedPerSecond`;
- `rendererConsumerChurnPerSecond`;
- `rendererDrawFailuresPerSecond`.

После трёх последовательных деградированных samples создаются incidents:

| Trigger | Условие |
| --- | --- |
| `screen_renderer_stalled` | свежие frames приходят, active consumer есть, но draw не продвигается 5 секунд, либо есть sustained draw failures |
| `screen_renderer_frames_dropped_critical` | минимум 20% и 5 superseded frames/s |
| `voice_stage_consumer_churn_critical` | минимум 4 attach/detach operations/s |

Incidents проходят тот же bounded automatic diagnostic pipeline, что и
предыдущие screen/RTC проблемы. Anonymous metrics получили три новых
allowlisted low-cardinality counters. Backend независимо принимает только эти
известные имена.

Исправлена дополнительная ошибка sanitization: длинный внутренний
`triggerCode` раньше мог ошибочно заменяться на `[redacted]` как похожий на
секрет. `triggerCode` и `errorCode` теперь сохраняются как safe identifiers.

## Изолированные regression/soak tests

Добавлены или расширены:

- `apps/web/src/features/sync/sync-store-react.test.tsx`
- `apps/web/src/features/voice/use-voice-stage-grid-layout.test.tsx`
- `apps/web/src/features/voice/use-voice-stage-focus-sizing.test.tsx`
- `apps/web/src/components/voice/voice-stage-grid-lifecycle.test.tsx`
- `apps/web/src/components/voice/voice-stage-focus-lifecycle.test.tsx`
- `apps/web/src/components/voice/voice-stage-video.test.tsx`
- `apps/web/src/features/voice/native-video-registry.test.ts`
- `apps/web/src/features/voice/voice-rtc-debug.test.ts`
- `apps/web/src/features/voice/rtc-health-monitor.test.ts`
- `apps/web/src/features/diagnostics/diagnostic-reporter.test.ts`
- `apps/desktop/src/main/native-runtime/screen-stream-observability.test.ts`
- `apps/desktop/src/main/screen-stream-report-bundle.test.ts`
- `services/backend/crates/delta/src/routes/telemetry.rs`

Soak границы:

- 100 000 burst frames: один pending rAF/frame, все заменённые frames закрыты;
- 10 000 remote canvas attach/detach: active consumers возвращаются к нулю,
  provider notifications не создаются;
- 1000 одинаковых ResizeObserver callbacks на каждый layout hook: render count
  не растёт;
- 200 чередований grid column layout: media consumers не remount-ятся.

## Проверки

Успешно:

```text
Web Vitest:                 212 files, 1060 tests
Web production build:      passed
Desktop Vitest:             42 files, 364 tests
Desktop typecheck:          passed
Backend telemetry test:     passed
Changed telemetry rustfmt:  passed
```

Общий `cargo fmt --all --check` остаётся красным на ранее существующих
formatting differences во множестве Rust-файлов вне этой задачи. Эти файлы не
изменялись.

## Ограничения

Приложение и реальный screen share не запускались, согласно требованию. Поэтому
не измерялись физические GPU driver timings и Electron compositor behavior на
конкретной машине.

Изолированными тестами закрыты воспроизводимые lifecycle, render-churn,
backing-store и observability причины. После доставки всё равно нужен
продолжительный hardware soak с несколькими одновременными 1080p/4K
демонстрациями, чтобы сопоставить новые counters с реальным vendor-specific GPU
поведением.
