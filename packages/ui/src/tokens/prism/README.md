# Prism (vendored)

Исходник `@empatraai/prism@0.2.0` из `empatraai/empatra-libraries`,
`packages/prism`. Скопирован в репозиторий по решению о полном переходе
на Prism (ADR-0016), без npm-пакета.

- `color-utils.ts` — OKLab/hex-утилиты.
- `prism-generator.ts` — генерация семантических токенов из якорей.
- `prism-defaults.ts`, `types.ts` — дефолтные якоря и контракт.
- `theme.ts` — утилиты применения темы (используются как справка; приложение
  применяет токены через `packages/ui/src/tokens/apply.ts`).

При обновлении Prism обновите эти файлы из upstream и прогоните
`pnpm ui:test`, `pnpm web:test`, `pnpm check:ui`.
