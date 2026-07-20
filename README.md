<div align="center">

# 🧀 СЫРНИКЕ13

```
        .-"""""-.
      .'  _ _ _  '.
     /   (o)(o)(o) \
    |    _________  |
     \  | СЫРНИК | /
      '. |_______|.'
        '-.......-'
```

### Дискорд? Не, не слышали. У нас сырники.

[![Version](https://img.shields.io/badge/version-0.6.3-blue?style=flat-square)](VERSION)
[![License: CC BY-NC 4.0](https://img.shields.io/badge/license-CC%20BY--NC%204.0-orange?style=flat-square)](LICENSE)
[![prod](https://img.shields.io/badge/prod-syrnike13.ru-success?style=flat-square)](https://syrnike13.ru)
[![nightly](https://img.shields.io/badge/nightly-beta.syrnike13.ru-blueviolet?style=flat-square)](https://beta.syrnike13.ru)
[![stack](https://img.shields.io/badge/stack-React%20%C2%B7%20Electron%20%C2%B7%20Rust%20%C2%B7%20LiveKit-informational?style=flat-square)](#-что-в-коробке)

</div>

---

**syrnike13** — это своя платформа для общения, которую мы печём сами:
серверы, каналы, голос, демонстрация экрана и мини-игры прямо в войсе.
Без корпораций, без трекеров, с собственным бэкендом на Rust и форком LiveKit,
потому что «просто взять готовое» — это не про нас.

## 🍳 Что в коробке

| | |
|---|---|
| 💬 **Серверы и каналы** | Текст, войс, роли, права, бейджи — всё как у больших, только наше |
| 🎙️ **Голос и видео** | Собственный форк LiveKit + нативный медиа-движок на C++/WebRTC с GPU-захватом экрана |
| 🏁 **Активности в каналах** | Мини-игры прямо в голосовом канале. Есть гонки сырников. Да, серьёзно |
| 🖥️ **Десктоп** | Electron-оболочка с автообновлениями, оверлеем и нативным аудио/видео |
| 🌙 **Nightly** | Отдельный бета-стенд [`beta.syrnike13.ru`](https://beta.syrnike13.ru) для ветки `develop` — ломаем там, чиним здесь |
| 🛠️ **Админка** | Модерация фидбека, диагностика, метрики — кухня ресторана |

## 🗂️ Карта монорепо

```
syrnike13-app/
├── apps/
│   ├── web/          # 🌐 React/TanStack клиент — основной интерфейс
│   ├── desktop/      # 🖥️  Electron-оболочка того же клиента
│   └── admin/        # 🛠️  Админ-панель
├── packages/
│   ├── platform/     # 🧩 Общий runtime для web и desktop
│   ├── api-types/    # 📜 Сгенерированные типы API
│   └── desktop-native/ # ⚙️  Нативный медиа-движок (C++/WebRTC)
├── services/
│   ├── backend/      # 🦀 Rust-бэкенд и демоны
│   └── livekit-server/ # 📡 Форк LiveKit для голоса
├── deploy/
│   ├── production/   # 🚀 Docker Compose прода
│   └── nightly/      # 🌙 Docker Compose беты
└── tooling/          # 🔧 Скрипты и автоматизация
```

`VERSION` в корне — единственный источник версии. Поменял его на `main` —
полетели релизные воркфлоу.

## 🚀 Погнали кодить

```sh
pnpm install
pnpm web:dev        # http://localhost:3000 — и ты уже внутри
```

Для UI-разработки локальный бэкенд **не нужен** — дев-сервер по умолчанию
смотрит на продакшен-API. Докер, Rust и прочие прелести подключаются только
когда хочется потрогать серверную часть.

```sh
pnpm web:test           # тесты веб-клиента
pnpm desktop:dev        # десктоп на Electron
pnpm backend:check      # cargo check всего бэкенда
pnpm livekit:check      # тесты LiveKit-форка
```

## 🌿 Как живём

- `develop` → nightly-стенд `beta.syrnike13.ru` (можно ломать, осторожно)
- `main` → продакшен `syrnike13.ru` (нельзя ломать, совсем)

## 📄 Лицензия

Код — под [CC BY-NC 4.0](LICENSE): изучай, форкай, экспериментируй на здоровье.
**Продавать нельзя** — для коммерческого использования нужна отдельная
договорённость с авторами.

Сторонние компоненты (форк LiveKit, вендорные зависимости) живут под своими
лицензиями — ищи `LICENSE`-файлы в их директориях.

---

<div align="center">
<sub>Сделано с любовью и творогом 🧀</sub>
</div>
