# UI syrnike13: правила, компоненты, эталоны

Единственный источник дизайн-правил для `packages/ui`, `apps/web`, `apps/landing` и `apps/admin`. Корневой `AGENTS.md` содержит только короткую выжимку и ссылку сюда.

**Главное правило:** все примитивы — **буквальный исходник shadcn/ui `base-nova`** (Base UI), скопированный в `packages/ui/src/primitives/<name>/index.tsx`. Не пишите локальные компоненты, «похожие на shadcn», не добавляйте самописные варианты и не оборачивайте примитивы без необходимости. Если нужного компонента нет — добавьте его из registry `base-nova`, а не собирайте заново.

Допустимые изменения исходника:

- адаптация цветов на семантические токены, если upstream использует палитру;
- добавление upstream-варианта в существующий компонент;
- интеграция портала с `usePortalContainer()` для Electron-попаутов;
- расширения под стиль продукта (метрики Discord, токены Prism) — прямо в исходнике примитива, с комментарием, зачем.

Всё остальное — отклонение от правила.

**Перед завершением UI-задачи:** `pnpm lint:design`. Baseline нет: любая находка — нарушение, она роняет команду и CI. Исправляйте код. Осознанное исключение — только на одну строку: `// eslint-disable-next-line <rule> -- <причина>`; отключать правила дизайна для файла или блока нельзя.

## Структура пакета

- `src/primitives/<name>/` — примитивы shadcn `base-nova` и колокейтед-тесты.
- `src/tokens/` — Prism-движок (`src/tokens/prism/`, вендоренный из `@empatraai/prism`), якоря тем (`monolit`, `glina`), применение темы и pre-hydration CSS.
- `src/i18n/` — `LocaleProvider`, `useTranslations`, встроенные подписи `ui`.
- `src/icons/` — общий реестр иконок и адаптер `icon-placeholder` для shadcn-исходников.
- `src/holidays/` — каталог окон праздников (`catalog.ts`), резолвер локальной даты (`resolve.ts`) и `HolidayProvider` для сезонных иконок.
- `src/lib/cn.ts` — `clsx` + `tailwind-merge`.
- `src/shadcn.css` — custom variants и utilities из `shadcn/tailwind.css`.
- `src/hooks/use-mobile.ts` — hook из shadcn registry.

Приложения подключают пакет как source-only workspace dependency (`@syrnike13/ui`), Tailwind сканирует `packages/ui/src` через `@source`.

## Каталог компонентов

Все компоненты импортируются напрямую: `@syrnike13/ui/primitives/<name>`.

| Группа | Компоненты |
| --- | --- |
| Foundations | `accordion`, `alert`, `aspect-ratio`, `avatar`, `badge`, `button`, `button-group`, `split-button`, `card`, `kbd`, `marker`, `progress`, `separator`, `skeleton`, `spinner` |
| Forms | `calendar`, `checkbox`, `combobox`, `field`, `input`, `input-group`, `input-otp`, `label`, `native-select`, `radio-group`, `select`, `slider`, `switch`, `textarea`, `toggle`, `toggle-group` |
| Data display | `attachment`, `breadcrumb`, `bubble`, `chart`, `code-block`, `empty`, `item`, `message`, `message-scroller`, `pagination`, `questionnaire`, `resizable`, `scroll-area`, `table`, `trace` |
| Overlays | `alert-dialog`, `command`, `context-menu`, `dialog`, `drawer`, `dropdown-menu`, `hover-card`, `menubar`, `navigation-menu`, `popover`, `sheet`, `sonner`, `toast`, `tooltip` |
| Layout/navigation | `carousel`, `collapsible`, `direction`, `sidebar`, `tabs` |

Важные API-особенности Base UI:

- вместо Radix `asChild` используется `render={<Element />}`; содержимое остаётся дочерними элементами;
- состояния выражаются data-атрибутами: `data-open`, `data-closed`, `data-checked`, `data-unchecked`, `data-disabled`, `data-highlighted`;
- `onOpenChange` получает вторым аргументом `details` с `reason`, `cancel()`, `event`;
- у `Select` значение может быть `null` — обрабатывайте это в `onValueChange`;
- пункты меню используют `onClick`, а не Radix-`onSelect`; чекбокс-пункты — `onCheckedChange` + `closeOnClick={false}`;
- ссылки не оборачиваются в `Button`: используйте `buttonVariants({ variant, size })` на `Link`/`<a>`.

Продуктовые исключения:

- `Squircle` остаётся фирменной формой rail-иконок; замены в shadcn нет.
- `portal-container` — инфраструктура Electron-попаутов: все overlay-порталы подхватывают контейнер через `usePortalContainer()`.
- `icon-placeholder` — адаптер имён иконок shadcn на `@remixicon/react`.

## Правила

- **Цвет — только семантические токены.** `text-foreground`, `text-muted-foreground`, `bg-background`, `bg-card`, `bg-muted`, `bg-accent`, `border-border`, `bg-primary`/`text-primary`, `text-destructive`, `text-success`, `text-warning` и их подложки. Палитра Tailwind (`text-emerald-600`, `bg-zinc-900`, `bg-white`) и произвольные цвета (`bg-[#…]`, `rgb(…)` в CSS) запрещены.
- **Темы — только якоря Prism.** Все цвета, включая `primary*`, `ring`, `destructive*` и `chart-*`, генерирует Prism из `accent`/`background`/`foreground`/`contrast`; отдельных бренд-цветов нет. `--input` — поверхность поля, `--color-input` в Tailwind — `--input-border`.
- **Shared-компоненты владеют поверхностью и состояниями** (фон, рамка, форма, hover/focus/disabled). В `className` на месте вызова — только layout (`w-full`, `mt-3`, `justify-start`, `md:mr-auto`) и текстовый токен.
- **Слайдеры в настройках — `PresetSlider`.** Любой слайдер в настройках (и любой новый слайдер с остановками, подписями или дискретными значениями) собирается из `apps/web/src/components/ui/preset-slider.tsx`: остановки, подписи, режимы `stops`/`continuous`, обычный вид без меток — `showLabels={false} showMarks={false}`. Примитив `@syrnike13/ui/primitives/slider` — его внутренняя база; напрямую в настройках не подключается, это проверяет `pnpm lint:design`. Исключения — live-визуализации вроде метра голосового гейта и dev-инструменты.
- **Двухстрочные пункты меню — через `description`.** Проп есть у `DropdownMenuItem`, `DropdownMenuSubTrigger`, `DropdownMenuCheckboxItem`, `DropdownMenuRadioItem` и их context-аналогов (вторая строка: 12px `text-muted-foreground`, остаётся приглушённой и при ховере, высота пункта — 50px). Не собирайте вторую строку самописными `span` внутри пункта. Ручные строки в поповерах (например, устройства в голосовой панели) — кандидаты на миграцию.
- **Кнопка с выпадающей стрелкой — `SplitButton`.** Микрофон, звук, камера и другие пары «действие + стрелка настроек» собираются из `SplitButton` + `SplitButtonMain` + `SplitButtonChevron` (`size`: `default` для панели, `lg` для голосовой сцены; `variant`: `default`, `destructive`, `success`). Наведённый сегмент подсвечивается полностью, соседний — вполсилы. Не собирайте такие пары из `ButtonGroup` и не делайте самодельных сегментов.
- **Лента чата — только `message`.** Это не base-nova bubble, а строка Discord (cozy): `Message` (`groupStart`, `highlighted`, `mentioned`), `MessageAvatar`, `MessageIcon` (системные строки), `MessageContent`, `MessageHeader`, `MessageTimestamp` (`placement="gutter"` у продолжения группы), `MessageNote` («(изменено)»), `MessageReply` (уголок рисует примитив), `MessageToolbar` (панель при наведении, `open` пока открыто меню), `MessageReactions` + `MessageReaction`/`MessageReactionAdd`, `MessageDivider` (`date`, `unread`). Отступы, фон наведения и подсветку строк не задавайте на месте вызова.
- **Пустые состояния — только `Empty`.** Любое «пусто / ничего не найдено / пока нет» собирается из `Empty` + `EmptyHeader`/`EmptyTitle`/`EmptyDescription` (иконка — `EmptyMedia variant="icon"`). Вид задаёт `size`: `page` — вся колонка (никого нет в сети, нет отзывов, не найдено), `default` — внутри панели или диалога, `sm` — поповеры, меню, сайдбары, результаты поиска, `inline` — строка внутри секции; `variant="card"` — карточка с фоном. Классы на `Empty` не передаются, голые `<p>` с «пусто» не пишутся.
- **Размеры в rem**, по возможности классами Tailwind. `px` — только для границ, focus-offset и canvas.
- **Адаптивность встроена.** Вёрстка обязана работать на 375px: `min-w-0`, `truncate`, `flex-col sm:flex-row`.
- **Иконки — только через реестр** `@syrnike13/ui/icons` или app-local `components/icons`. Прямые импорты `@remixicon/react`, `@iconify/react`, `iconoir-react`, `lucide-react` внутри shadcn-исходников допустимы только в `icon-placeholder`. Иконки iconify лежат в проекте: после нового `iconifyIcon('prefix:name')` запустите `pnpm --filter @syrnike13/web icons:build` (набор `@iconify-json/<prefix>` — в devDependencies web).
- **Строки интерфейса — только через i18n.** Web: `useTranslations` из `@syrnike13/ui/i18n`, ключи в `apps/web/src/messages/{en,ru}.json`. Landing: `apps/landing/src/messages/{en,ru}.json`. Admin: `apps/admin/src/messages/{en,ru}.json`. Это касается и `aria-label`, `placeholder`, `title`.
- **Контракты desktop не ломать:** `.dark`, `data-theme`, `data-theme-gradient`, имена семантических CSS-переменных, `.theme-surface-*`, `.gradient-surface-*`, `.shell-title-bar-drag/no-drag`, `data-overlay-panel`, `data-participant-*`, `data-slot="scroll-area-viewport"`, прозрачность overlay, popout-клонирование стилей.

## Линтер дизайна

`pnpm lint:design` — ESLint с плагином `tooling/eslint-plugin-design` и правилами `@shadcn/lint`. Он защищает от двух вещей: переопределения стилей примитивов и самописных копий вместо существующих компонентов.

| Правило | Что запрещает |
| --- | --- |
| `design/no-restyle` | визуальные классы на примитиве, у которого есть своя поверхность (это определяется по исходнику в `packages/ui`), на элементе из его `render` и рядом с `*Variants()`. Разрешено только размещение: margin, ширина, flex/grid/position, `gap`, `p-0`, видимость, текстовый цвет-токен |
| `design/no-lookalike` | сырые `button`, `input`, `textarea`, `select`, ссылки со своими поверхностями и `div`/`span` с `onClick` — нужен примитив |
| `design/no-hardcoded-text` | текст интерфейса в JSX и в `aria-label`/`title`/`placeholder`/`alt`/`label` мимо i18n |
| `design/require-disable-reason` | отключение правил дизайна без причины или на весь файл |
| `design-css/*` | CSS-селекторы по `[data-slot]` и литеральные цвета вне custom properties |
| `shadcn/*` | неизвестные Tailwind-классы, произвольные значения, палитровые цвета, inline-стили, динамические классы |
| `no-restricted-imports` | иконки мимо реестра, примитив `Slider` в настройках |

Нужен другой вид — добавьте вариант или размер в примитив, а не класс на месте вызова.

## Добавление компонента из shadcn

1. Возьмите исходник registry `base-nova` (`https://ui.shadcn.com/r/styles/base-nova/<name>.json`).
2. Положите его в `src/primitives/<name>/index.tsx` без изменения разметки и классов.
3. Перепишите импорты: `cn` → `../../lib/cn`, `@/registry/base-nova/ui/<x>` → `../<x>`, `icon-placeholder` → `../icon-placeholder`.
4. Если источник использует палитровые цвета — замените их на семантические токены.
5. Добавьте `usePortalContainer()` в портал, если компонент рендерит overlay.
6. Экспортируйте компонент из `src/index.ts`.
7. Запустите `pnpm lint:design` и `pnpm ui:typecheck`.

## Сезонные иконки

Сезонность в интерфейсе ограничена подменой иконок: общих эффектов, оверлеев и слотов в пакете нет. Новые сезонные глифы и любые визуальные эффекты добавляются только по явному запросу, а не «на будущее».

- **Каталог** — `packages/ui/src/holidays/catalog.ts`. Окно задаётся локальными `MM-DD` без года, `from > to` означает переход через Новый год; время суток и таймзоны намеренно не учитываются.
- **Провайдер** — `HolidayProvider` монтируется в корне приложения, раз в минуту перепроверяет дату и публикует активный праздник через `useActiveHoliday()` (без провайдера возвращает `null`).
- **Dev-предпросмотр** — общая панель `DevToolsOverlay` с вкладками Holidays и Themes. `useHolidayPreview()` переключает `auto` / `off` / праздник; сохранение выбора включается только в DEV через `overrideStorageKey`. Панель и каталог не являются пользовательскими эффектами и сохраняются независимо от artwork.
- **Иконка** — `defineHolidayIcon(base, source, { <holidayId>: Glyph })` в `apps/web/src/components/icons/registry/*`. Имя иконки (`HomeIcon`) не меняется; вне окна рендерится базовая.
- **Сейчас сезонная иконка одна:** `HomeIcon` → тыква на Хэллоуин (`apps/web/src/components/icons/holiday/halloween.tsx`).

## Эталонные экраны

| Тип экрана | Эталон | Что правильно |
| --- | --- | --- |
| Раздел настроек | `apps/web/src/components/settings/settings-panels.tsx` | секции, загрузка/ошибка/пусто, `toast` по итогу |
| Чат/канал | `apps/web/src/components/chat/channel-view.tsx` | header + list + composer + sidebars |
| Голос | `apps/web/src/components/voice/voice-stage-view.tsx` | stage/grid/filmstrip, контролы |
| Auth | `apps/web/src/components/auth/auth-layout.tsx` | центрирование, тема, ошибки |
| Mobile | `apps/web/src/routes/m/c/$channelId.tsx` | drawer/Sheet, safe-area, тач |
| Overlay | `apps/web/src/features/overlay/desktop-overlay-hud.tsx` | прозрачность, data-контракты |
| Admin | `apps/admin/src/components/admin-shell.tsx` | навигация, плотность, dark-only |
| Каталог | `apps/web/src/features/ui-gallery/ui-gallery-page.tsx` | все примитивы, палитры, примеры |

## Проверка

```sh
pnpm lint:design           # правила дизайна; 0 находок, без baseline
pnpm lint:design:test      # тесты самих правил (tooling/eslint-plugin-design)
pnpm ui:typecheck && pnpm web:typecheck && pnpm admin:typecheck
pnpm ui:test && pnpm web:test && pnpm admin:test
pnpm web:build && pnpm admin:build
```

Вид проверяйте в `pnpm web:dev` (:3001), `pnpm landing:dev` (:3000) и `pnpm admin:dev` (:3002): light/dark, 375px и desktop, обе Prism-темы, en/ru. Desktop — только `pnpm desktop:dev`. Каталог компонентов — `http://localhost:3001/dev/ui`. В dev-сборке web справа снизу есть **DEV**: вкладка Holidays для предпросмотра праздников и вкладка Themes — workbench всех тем Prism. В нём можно выбрать или добавить тему, отполировать якоря `accent`/`background`/`foreground`/`contrast` для light и dark, покрутить глобальные `surfaceMix`/`raisedMix`, а затем выгрузить единый JSON со всеми темами и `tuning` для переноса в `catalog.ts` и `DEFAULT_PRISM_TUNING`.
