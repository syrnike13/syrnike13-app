# UI syrnike13: правила, компоненты, эталоны

Единственный источник дизайн-правил для `packages/ui`, `apps/web` и `apps/admin`. Корневой `AGENTS.md` содержит только короткую выжимку и ссылку сюда.

**Главное правило:** интерфейс собирается из готовых компонентов и копирует структуру эталонных экранов. Новый примитив, свой цвет, свой радиус или своя кнопка — ошибка, если сначала не проверен каталог ниже. Нужного вида нет — добавь variant в существующий компонент, а не пиши локальную копию.

**Перед завершением UI-задачи:** `pnpm check:ui`. Новое нарушение роняет команду и CI. Исправляй код, а не `tooling/ui-baseline.json`. Осознанное исключение помечай `// design-allow <rule>: <причина>` (в JSX `{/* … */}`) на той же или предыдущей строке, а для целого файла — `// design-allow-file <rule>: <причина>` в первых 12 строках. Без причины исключение не пройдёт ревью.

## Структура пакета

- `src/primitives/<name>/` — общие React-примитивы с колокейтед-тестами.
- `src/tokens/` — 21 тема, деривация semantic tokens, применение темы и pre-hydration CSS.
- `src/i18n/` — LocaleProvider, `useTranslations`, встроенные подписи `ui`.
- `src/icons/` — общий реестр иконок.
- `src/lib/cn.ts` — `clsx` + `tailwind-merge`.
- `src/styles.css` — `@theme inline` и базовые стили пакета.

Приложения подключают пакет как source-only workspace dependency (`@syrnike13/ui`), Tailwind сканирует `packages/ui/src` через `@source`.

## Каталог компонентов

| Задача | Бери | Не делай |
| --- | --- | --- |
| Кнопка | `Button` (`default`, `destructive`, `outline`, `secondary`, `ghost`, `link`; размеры `xs…lg`, `icon*`) | `<button className="bg-… rounded-…">`, свои классы формы |
| Иконка-кнопка | `IconButton` + `aria-label` | фиксированные `size-8` вне компактных панелей |
| Статус | `Badge` (`default`, `secondary`, `outline`, `destructive`, `success`, `warning`, `muted`) | `span` с `bg-emerald-500/15` |
| Поверхность | `Squircle`, `Card`, `LayerCard` | `div` с `rounded-[…]`, локальные тени |
| Поле с подписью | `Field` вокруг `Input` / `Textarea` / `Select` | свои `FormField`, `space-y-1.5` + `Label` |
| Поиск | `SearchField` | `Input` с иконкой лупы |
| Подтверждение | `AlertDialog` или `PromptSheet` (когда появится) | свой overlay |
| Диалог | `Dialog`, на телефоне — `Sheet`/`Drawer` | самодельный портал и затемнение |
| Меню | `DropdownMenu`, `ContextMenu` | `title="…"` вместо `Tooltip` |
| Загрузка | `Skeleton`, `Spinner` | `Loader2` + `animate-spin` |
| Уведомление | `toast` из `sonner` | свои всплывашки |
| Строка списка | `ListItem` | `<button className="flex w-full … hover:bg-…">` |

Каталог расширяется по мере переноса примитивов. До завершения миграции `apps/web/src/components/ui/*` — re-export шимы; новый код импортирует из `@syrnike13/ui`.

## Правила

- **Цвет — только семантические токены.** `text-foreground`, `text-muted-foreground`, `bg-background`, `bg-card`, `bg-muted`, `bg-accent`, `border-border`, `bg-primary`/`text-primary`, `text-destructive`, `text-success`, `text-warning` и их подложки. Палитра Tailwind (`text-emerald-600`, `bg-zinc-900`, `bg-white`) и произвольные цвета (`bg-[#…]`, `rgb(…)` в CSS) запрещены. Нужного токена нет — добавь его в `src/styles.css`.
- **Shared-компоненты владеют поверхностью и состояниями** (фон, рамка, форма, hover/focus/disabled). В `className` у `Button`, `Badge`, `Input`, `Textarea`, `SelectTrigger`, `Alert`, `TabsTrigger`, `Switch`, `Checkbox`, `ListItem`, `SearchField`, `Field` — только layout (`w-full`, `mt-3`, `justify-start`, `md:mr-auto`) и, при необходимости, текстовый токен.
- **Размеры в rem**, по возможности классами Tailwind. `px` — только для границ, focus-offset и canvas. Никаких `text-[13px]`.
- **Адаптивность встроена.** `Input`, `Textarea`, `SelectTrigger`, `Button` и пункты меню сами увеличиваются на узком экране. Не переключай размеры по `isMobile`; вёрстка обязана работать на 375px, `min-w-0`, `truncate`, `flex-col sm:flex-row`.
- **Иконки — только через реестр** `@syrnike13/ui/icons` или app-local `components/icons`. Прямые импорты `@remixicon/react`, `@iconify/react`, `iconoir-react`, `lucide-react` запрещены checker-ом.
- **Строки интерфейса — только через i18n.** Web: `useTranslations` из `@syrnike13/ui/i18n`, ключи в `apps/web/src/messages/{en,ru}.json`. Admin: те же правила, `apps/admin/src/messages/{en,ru}.json`. Это касается и `aria-label`, `placeholder`, `title`.
- **Контракты desktop не ломать:** `.dark`, `data-theme`, `data-theme-gradient`, имена семантических CSS-переменных, `.theme-surface-*`, `.gradient-surface-*`, `.shell-title-bar-drag/no-drag`, `data-overlay-panel`, `data-participant-*`, `data-slot="scroll-area-viewport"`, прозрачность overlay, popout-клонирование стилей.

## Эталонные экраны

Новый экран начинай с копии структуры ближайшего эталона, а не с чистого листа.

| Тип экрана | Эталон | Что правильно |
| --- | --- | --- |
| Раздел настроек | `apps/web/src/components/settings/settings-panels.tsx` (до миграции) | секции, загрузка/ошибка/пусто, `toast` по итогу |
| Чат/канал | `apps/web/src/components/chat/channel-view.tsx` | header + list + composer + sidebars |
| Голос | `apps/web/src/components/voice/voice-stage-view.tsx` | stage/grid/filmstrip, контролы |
| Auth | `apps/web/src/components/auth/auth-layout.tsx` | центрирование, тема, ошибки |
| Mobile | `apps/web/src/routes/m/c/$channelId.tsx` | drawer/Sheet, safe-area, тач |
| Overlay | `apps/web/src/features/overlay/desktop-overlay-hud.tsx` | прозрачность, data-контракты |
| Admin | `apps/admin/src/components/admin-shell.tsx` | навигация, плотность, dark-only |

## Проверка

```sh
pnpm check:ui              # правила; baseline только уменьшается
pnpm check:ui:update       # пересчитать baseline после исправлений
pnpm ui:typecheck && pnpm web:typecheck && pnpm admin:typecheck
pnpm ui:test && pnpm web:test && pnpm admin:test
pnpm web:build && pnpm admin:build
```

Вид проверяй в `pnpm web:dev` (:3000) и `pnpm admin:dev` (:3001): light/dark, 375px и desktop, все 21 темы, en/ru. Desktop — только `pnpm desktop:dev`.
