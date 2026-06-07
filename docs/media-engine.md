# Windows Media Engine

Документ описывает цель, архитектуру, текущее состояние и план развития нативного media engine для Windows desktop в monorepo `syrnike13-app`.

## Актуальная ветка и PR

| Что | Значение |
|-----|----------|
| **Ветка** | `cursor/media-engine-win-bdc4` |
| **PR** | [#4](https://github.com/syrnike13/syrnike13-app/pull/4) (draft) |
| **База** | `main` — media engine в main ещё не смержен |
| **Последний коммит** | `97dcd65` — camera device picker + engine RTC debug |

### Устаревшие ветки / PR

| Ветка | PR | Статус |
|-------|-----|--------|
| `cursor/media-engine-phase3-bdc4` | [#5](https://github.com/syrnike13/syrnike13-app/pull/5) | Устарел — срез только до Phase 3, полностью входит в PR #4 |
| `cursor/media-engine-phase2-bdc4` | — | Локальный черновик (Phase 2) |
| `cursor/media-engine-audio-bdc4` | — | Локальный черновик (screen share audio) |

**Итог:** смотреть и мержить нужно **PR #4**. PR #5 можно закрыть как superseded.

---

## Цель

Довести **нативный media engine** в Windows desktop (`syrnike-media-engine-win.exe`) до **минимального паритета с браузерным voice path** (LiveKit в Chromium).

На Windows desktop голос, screen share и камера должны идти через отдельный Rust-процесс, а не через `getUserMedia` / `getDisplayMedia`. Web UI остаётся в Electron renderer; медиа — в engine + IPC.

**Зачем:**

- Стабильнее screen capture (WGC/DXGI/GDI hybrid)
- Нативный WASAPI для микрофона и loopback аудио демонстрации
- Единая LiveKit Room в engine на весь voice session
- Меньше ограничений Chromium на Windows

**Включение engine path:** capability `nativeMediaEngine` на `win32` + desktop runtime. Флаг `VITE_NATIVE_MEDIA_ENGINE` убран — на Windows desktop engine path включён по умолчанию через `shouldUseDesktopMediaEngine()`.

---

## Архитектура

```
┌─────────────────────────────────────────────────────────────┐
│  Electron Renderer (apps/web)                               │
│  voice-provider, settings, stage UI                         │
└──────────────────────────┬──────────────────────────────────┘
                           │ IPC (preload → main)
┌──────────────────────────▼──────────────────────────────────┐
│  Electron Main (apps/desktop/src/main)                      │
│  media-engine.ts — spawn, health ping, auto-restart, RPC    │
└──────────────────────────┬──────────────────────────────────┘
                           │ named pipe (JSON-RPC + events)
┌──────────────────────────▼──────────────────────────────────┐
│  syrnike-media-engine-win.exe (Rust)                        │
│  LiveKit Room · WASAPI · nokhwa · hybrid screen capture     │
└─────────────────────────────────────────────────────────────┘
```

| Слой | Путь | Роль |
|------|------|------|
| Rust engine | `apps/desktop/native/media-engine-win/` | LiveKit, capture, RPC, event emit |
| Desktop main | `apps/desktop/src/main/media-engine.ts` | Process supervision, pipe I/O |
| Platform types | `packages/platform/src/media-engine.ts` | IPC контракт, event types |
| Web voice | `apps/web/src/features/voice/` | Engine vs browser switch, UI wiring |

---

## Хронология (коммиты в PR #4)

### Phase 0 — Scaffold (`6d92737`)

- Отдельный процесс `syrnike-media-engine-win`
- JSON-RPC over named pipe
- `engine.ping`, `room.connect`, test tone publish
- Electron: spawn, health checks, auto-restart (до 3 попыток)

### Phase 1 — Screen capture (`60d5cf9`)

- Hybrid WGC/DXGI/GDI capture в engine
- I420 → LiveKit `NativeVideoSource`
- RPC `screen.start` / `screen.stop`
- Native picker IPC, интеграция в web

### Screen share audio (`8278b72`)

- WASAPI loopback in-process (без TCP sidecar)
- `ScreenshareAudio` track через `NativeAudioSource`
- Режимы process tree / system_exclude

### Phase 2 — Engine-owned voice (`9eb3c5c`)

- Одна LiveKit Room в engine на весь voice session
- `mic.setEnabled` через WASAPI + publish
- Remote audio PCM → renderer → Web Audio playback
- Screen share без отдельного `roomConnect`
- `getDisplayMedia` отклоняется на Windows

### Phase 3 — Remote video + camera (`5b56ccd`)

- Remote screen/camera: JPEG ~15 fps over IPC
- `camera.setEnabled`, nokhwa capture
- Engine video tiles на voice stage

### Phase 4 — Preview + sync (`a576dd9`)

- `local.preview.frame` для self tiles
- `room.participants`, `track.published/unpublished`
- Rejoin при `room.disconnected`

### DeepFilterNet (`659483d`)

- Browser: `deepfilternet3-noise-filter` (локальный WASM, без CDN)
- Engine: `deep_filter` v0.5.6 в `mic_denoise.rs`
- RPC `mic.setNoiseSuppression`, проводка prefs

### Voice parity slice (`6be71d0`)

- Voice gate (RMS + hysteresis)
- `devices.list` (WASAPI audio)
- `mic.setDevice`, `mic.setProcessing`
- `room.getRtt`, `room.activeSpeakers`
- Remote audio: gain graph, per-user volume, auto-balance, `setSinkId`
- Live prefs в engine mode

### WASAPI mic picker (`84b7cdb`)

- `useVoiceAudioInputDevices` + reconcile browser id → WASAPI id по label
- Settings + stage mic menus
- Mic test скрыт в engine mode

### Camera picker + RTC debug (`97dcd65`)

- Камеры в `devices.list` (nokhwa/MSMF, `videoinput`)
- RPC `camera.setDevice` + restart capture
- `useVoiceVideoDevices` + live apply `preferredVideoDevice`
- `collectEngineRtcDebugSnapshot` (RTT ping, без browser RTC stats)

---

## RPC API (текущий контракт)

### Requests

```
engine.ping
engine.shutdown
room.connect
room.disconnect
room.getRtt
room.publishTestTone
mic.setEnabled
mic.setNoiseSuppression
mic.setDevice
mic.setProcessing
camera.setEnabled
camera.setDevice
screen.start
screen.stop
devices.list
```

### Events

```
engine.ready
engine.crashed
engine.restarted
room.state
room.connected
room.disconnected
room.participants
room.activeSpeakers
remote.audio.frame
remote.audio.ended
remote.video.frame
remote.video.ended
local.preview.frame
local.preview.ended
track.published
track.unpublished
screen.started
screen.stopped
```

---

## Ключевые файлы

| Область | Файлы |
|---------|-------|
| Rust engine | `apps/desktop/native/media-engine-win/src/` |
| RPC / session | `protocol.rs`, `session.rs` |
| Mic | `mic_publish.rs`, `mic_processing.rs`, `mic_denoise.rs`, `mic_gate.rs` |
| Camera | `camera_publish.rs` |
| Devices | `devices.rs` |
| Screen | `screen_publish.rs`, hybrid capture modules |
| Remote media | `remote_audio.rs`, `remote_video.rs` |
| Platform IPC | `packages/platform/src/media-engine.ts`, `ipc.ts`, `api.ts` |
| Desktop main | `apps/desktop/src/main/media-engine.ts`, `ipc.ts` |
| Preload | `apps/desktop/src/preload/index.ts` |
| Web voice | `voice-provider.tsx`, `media-engine-voice.ts`, `media-engine-voice-setup.ts` |
| Remote audio | `media-engine-remote-audio.ts` |
| Remote video | `media-engine-remote-video.ts` |
| Device hooks | `use-voice-audio-devices.ts`, `use-voice-video-devices.ts` |
| Device reconcile | `voice-audio-devices.ts` |
| Prefs effects | `voice-preference-effects.ts` |
| Settings UI | `settings-voice-panel.tsx` |
| RTC debug | `voice-rtc-debug.ts`, `voice-rtc-debug-view.tsx` |
| Engine gate | `desktop-media-engine.ts` |

---

## Архитектурные решения

| Тема | Решение |
|------|---------|
| Mic device ids | Browser `enumerateDevices` id ≠ WASAPI id → reconcile по **label**, fallback default |
| Output device | Browser ids + `setSinkId` (корректно для Web Audio в renderer) |
| Camera ids | Nokhwa index как string `"0"`, `"1"`… + reconcile по label |
| Смена mic/camera device | Перезапуск capture (краткий разрыв) |
| Remote video | JPEG over IPC (~15 fps) — временное решение |
| Rust в CI | Не компилируется на Linux — Windows-only, осознанно |
| Native AEC/AGC | RPC `mic.setProcessing` принимает prefs, в WASAPI path пока **no-op** |
| Voice gate | При открытом gate DeepFilterNet не применяется |
| Screen share на Windows | Только через engine; browser `getDisplayMedia` отклоняется |

---

## Текущее состояние паритета

### Работает в engine mode

| Функция | Browser | Engine |
|---------|---------|--------|
| Voice join / leave | ✅ | ✅ |
| Mic on/off | ✅ | ✅ |
| Mic device picker | ✅ | ✅ (WASAPI) |
| Mic processing (gate, denoise) | ✅ | ✅ (DeepFilterNet, gate) |
| Output device + volume | ✅ | ✅ (setSinkId + gain graph) |
| Per-user volume / auto-balance | ✅ | ✅ |
| Deafen | ✅ | ✅ |
| Ping / RTT display | ✅ | ✅ (`room.getRtt`) |
| Active speakers | ✅ | ✅ (`room.activeSpeakers`) |
| Screen share | ✅ | ✅ (hybrid capture) |
| Screen share audio | ✅ | ✅ (WASAPI loopback) |
| Camera on/off | ✅ | ✅ |
| Camera device picker | ✅ | ✅ (nokhwa) |
| Remote audio | ✅ | ✅ (PCM over IPC) |
| Remote video (stage) | ✅ | ⚠️ JPEG tiles |
| Local preview (self tile) | ✅ | ✅ (JPEG preview) |
| Participant sync | ✅ | ✅ (engine events) |
| RTC debug panel | ✅ full | ⚠️ RTT + screen shares only |
| Mic test в settings | ✅ | ❌ скрыт |

### Ещё не сделано / частично

- **Native AEC/AGC** — prefs есть, engine no-op
- **Полный RTC debug** — нет RTP stats из engine (нет `room.getStats`)
- **Remote video** — JPEG over IPC, не нативный decode/render
- **Engine remote screen unsubscribe** — UI-only gap
- **Input volume** — pref есть, в engine mic path может не применяться
- **Windows CI** для Rust engine
- **macOS/Linux engine** — out of scope этой ветки

---

## Известные ограничения

1. Смена mic device или processing перезапускает capture — краткий разрыв публикации.
2. Browser `enumerateDevices()` id не совпадает с WASAPI id — для микрофона и камеры используется reconcile по label.
3. Output device остаётся на browser ids — это корректно для Web Audio `setSinkId`.
4. Remote video — JPEG ~15 fps over IPC, не полноценный WebRTC video path в renderer.
5. Rust engine собирается только на Windows; Linux CI его не проверяет.
6. RTC debug в engine mode показывает RTT и screen share metadata, но не browser-style RTP/transport stats.

---

## План на будущее

### P1 — Закрыть очевидные gaps паритета

1. **Native AEC/AGC** — WASAPI DSP modes или post-process; сейчас prefs игнорируются.
2. **Input volume** в engine mic path (если нужен паритет с browser gain).
3. **Engine remote screen unsubscribe** — когда пользователь отписывается от чужого screen share.

### P2 — Качество медиа

4. **Remote video без JPEG** — H264 decode в renderer или shared texture path.
5. **Полный RTC debug** — `room.getStats` из LiveKit Rust SDK → transport/RTP в debug panel.
6. **Camera** — разрешение/FPS из prefs, не hardcoded 640×480@15.

### P3 — Инфраструктура

7. **Windows CI** — cross-compile или self-hosted runner для `media-engine-win`.
8. **PR #4 → ready for review** — закрыть PR #5 как superseded, финальный smoke на Windows.
9. **Dev setup** — troubleshooting pipe/permissions, сборка engine локально.

### P4 — За пределами scope

- macOS AVFoundation engine
- Linux V4L2/PulseAudio engine
- Electron offscreen WebRTC как альтернатива

---

## Тестирование

| Проверка | Команда / статус |
|----------|----------------|
| Web unit tests | `pnpm web:test` — 217 passed |
| Desktop typecheck | `pnpm --filter @syrnike13/desktop exec tsc --noEmit` |
| Platform build | `pnpm --filter @syrnike13/platform build` |
| Rust engine build | Только Windows (`apps/desktop/native/media-engine-win/`) |
| E2E smoke | Ручной на Windows: voice join, mic/camera switch, screen share, remote tiles |

### Рекомендуемый smoke checklist (Windows)

- [ ] Engine стартует, `engine.ping` ok
- [ ] Voice join через engine path
- [ ] Mic on/off, смена mic device в settings
- [ ] Camera on/off, смена camera device
- [ ] Screen share + audio
- [ ] Remote audio слышен, per-user volume работает
- [ ] Remote video tiles отображаются
- [ ] RTT/ping в UI
- [ ] Speaking indicators (active speakers)
- [ ] RTC debug panel открывается в engine mode
- [ ] Rejoin после engine disconnect

---

## Сборка и dev

```sh
# Установка зависимостей
pnpm install

# Web dev
pnpm web:dev

# Desktop dev (Windows)
pnpm desktop:dev

# Web tests
pnpm web:test

# Platform types (после изменений в packages/platform)
pnpm --filter @syrnike13/platform build
```

Rust engine собирается как часть desktop build на Windows. Исполняемый файл: `syrnike-media-engine-win.exe` (ищется в `out/native/`, `target/release/`, `target/debug/`).

---

## Связанные документы

- `docs/superpowers/specs/2026-06-05-voice-quality-design.md` — дизайн voice quality
- `docs/superpowers/plans/2026-06-05-voice-quality.md` — план voice quality
- `AGENTS.md` — общий контекст monorepo и production

---

## Краткий итог

Windows-native media stack для syrnike13 desktop: отдельный Rust engine владеет LiveKit-сессией, захватом экрана/микрофона/камеры и форвардит медиа в web UI через IPC. За несколько итераций voice path доведён почти до паритета с браузером; остались AEC/AGC, качество remote video и полный RTC debug.
