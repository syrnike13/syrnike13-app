---
name: syrnike-ui
description: Use this skill for any UI change in the syrnike13 app — new screens, edits to existing screens, new components, theme work, responsive/mobile layout, overlay or desktop chrome, or localization. It enforces the shared design system in packages/ui, the semantic token rules, the i18n workflow, and the mechanical checker.
---

# Syrnike UI

Собирай интерфейс из общей дизайн-системы, а не из локальных копий. Полный каталог и правила — `packages/ui/AGENTS.md`; визуальный язык — `DESIGN.md`.

## Порядок работы

1. **Прочитай правила.** `packages/ui/AGENTS.md` и `DESIGN.md`. Не начинай с чистого листа.
2. **Выбери ближайший эталон.** Скопируй структуру из таблицы эталонных экранов (чат, голос, настройки, auth, mobile, overlay, admin).
3. **Проверь каталог примитивов.** `@syrnike13/ui/primitives/*`: Button, IconButton, Badge, Input, Textarea, Label, Field, SearchField, Select, Checkbox, Switch, Slider, Dialog, AlertDialog, Sheet, Popover, Tooltip, DropdownMenu, ContextMenu, Tabs, ScrollArea, Card, LayerCard, ListItem, Skeleton, Spinner, Kbd, Marker, Progress.
4. **Собери экран.**
   - Цвет — только семантические токены (`background`, `card`, `muted`, `foreground`, `primary`, `destructive`, `success`, `warning`, `border`, `chart-*`, `scrim`, `on-scrim`, `on-media`, `media-backdrop`).
   - Поверхность, рамка, радиус, тень и состояния — ответственность примитива. В `className` только layout и текстовый токен.
   - Размеры — в rem или классами Tailwind; px только для границ, focus-offset и canvas.
   - Иконки — из `@syrnike13/ui/icons` или app-local `components/icons`; прямые импорты icon-пакетов запрещены.
5. **Локализуй всё.** `useTranslations('<namespace>')`; ключи добавляй и в `en`, и в `ru`. Переводи aria-label, placeholder, title, toast, ошибки и пустые состояния. Не собирай строки конкатенацией — используй `{name}`-интерполяцию и ICU-плюрализацию.
6. **Не ломай desktop-контракты.** `.dark`, `data-theme`, `data-theme-gradient`, `.theme-surface-*`, `.gradient-surface-*`, `.shell-title-bar-drag/no-drag`, `data-overlay-panel`, `data-participant-*`, `data-slot="scroll-area-viewport"`, прозрачность overlay, popout-стили.
7. **Проверь.** `pnpm check:ui`, `pnpm check:messages`, typecheck/tests/build затронутых приложений. Новое нарушение чини в коде, а не в baseline.

## Запрещено

- `text-emerald-600`, `bg-zinc-900`, `bg-white`, `bg-black/50`, `bg-[#…]`, `rgb(…)` в CSS.
- `rounded-[5px]`, `text-[13px]`, `w-[296px]` (используй rem/шкалу).
- Локальные `function Button`, копии Dialog/Select/Input.
- `window.innerWidth` для выбора layout; только CSS/container queries.
- Русские строки в TSX вне каталогов `messages`.
- Прямые импорты `@remixicon/react`, `@iconify/react`, `iconoir-react`, `lucide-react`.

## Осознанные исключения

Техническая строка, которую нельзя локализовать (метаданные документа, язык-данные, внутренние guard-ошибки), помечается:

```ts
// design-allow hardcoded-string: <причина>
```

или для файла целиком — `// design-allow-file <rule>: <причина>` в первых 12 строках. Без причины исключение не пройдёт ревью.
