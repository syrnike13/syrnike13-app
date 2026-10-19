# UI syrnike13: правила, компоненты, эталоны

Единственный источник дизайн-правил для `packages/ui`, `apps/web` и `apps/admin`. Корневой `AGENTS.md` содержит только короткую выжимку и ссылку сюда.

**Главное правило:** все примитивы — **буквальный исходник shadcn/ui `base-nova`** (Base UI), скопированный в `packages/ui/src/primitives/<name>/index.tsx`. Не пишите локальные компоненты, «похожие на shadcn», не добавляйте самописные варианты и не оборачивайте примитивы без необходимости. Если нужного компонента нет — добавьте его из registry `base-nova`, а не собирайте заново.

Допустимые изменения исходника:

- адаптация цветов на семантические токены, если upstream использует палитру;
- добавление upstream-варианта в существующий компонент;
- интеграция портала с `usePortalContainer()` для Electron-попаутов;
- комментарии `// design-allow-file <rule>: literal shadcn base-nova source`, если checker ругается на upstream-классы.

Всё остальное — отклонение от правила.

**Перед завершением UI-задачи:** `pnpm check:ui`. Новое нарушение роняет команду и CI. Исправляйте код, а не baseline. Осознанное исключение — `// design-allow <rule>: <причина>` на той же/предыдущей строке или `// design-allow-file <rule>: <причина>` в первых 12 строках.

## Структура пакета

- `src/primitives/<name>/` — примитивы shadcn `base-nova` и колокейтед-тесты.
- `src/tokens/` — Prism-движок (`src/tokens/prism/`, вендоренный из `@empatraai/prism`), якоря тем (`monolit`, `glina`), применение темы и pre-hydration CSS.
- `src/i18n/` — `LocaleProvider`, `useTranslations`, встроенные подписи `ui`.
- `src/icons/` — общий реестр иконок и адаптер `icon-placeholder` для shadcn-исходников.
- `src/lib/cn.ts` — `clsx` + `tailwind-merge`.
- `src/shadcn.css` — custom variants и utilities из `shadcn/tailwind.css`.
- `src/hooks/use-mobile.ts` — hook из shadcn registry.

Приложения подключают пакет как source-only workspace dependency (`@syrnike13/ui`), Tailwind сканирует `packages/ui/src` через `@source`.

## Каталог компонентов

Все компоненты импортируются напрямую: `@syrnike13/ui/primitives/<name>`.

| Группа | Компоненты |
| --- | --- |
| Foundations | `accordion`, `alert`, `aspect-ratio`, `avatar`, `badge`, `button`, `button-group`, `card`, `kbd`, `marker`, `progress`, `separator`, `skeleton`, `spinner` |
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
- **Темы — только якоря Prism.** Не задавайте поверхности, бордеры и состояния вручную: `generatePrismTokens` выводит их из `accent`/`background`/`foreground`/`contrast`. Бренд-цвета (`primary*`, `destructive*`, `ring`, `chart-*`) — единственное исключение и накладываются после Prism. `--input` — поверхность поля, `--color-input` в Tailwind — `--input-border`.
- **Shared-компоненты владеют поверхностью и состояниями** (фон, рамка, форма, hover/focus/disabled). В `className` на месте вызова — только layout (`w-full`, `mt-3`, `justify-start`, `md:mr-auto`) и текстовый токен.
- **Слайдеры в настройках — `PresetSlider`.** Любой слайдер в настройках (и любой новый слайдер с остановками, подписями или дискретными значениями) собирается из `apps/web/src/components/ui/preset-slider.tsx`: остановки, подписи, режимы `stops`/`continuous`, обычный вид без меток — `showLabels={false} showMarks={false}`. Примитив `@syrnike13/ui/primitives/slider` — его внутренняя база; напрямую в настройках не подключается, это проверяет `pnpm check:ui`. Исключения — live-визуализации вроде метра голосового гейта и dev-инструменты.
- **Размеры в rem**, по возможности классами Tailwind. `px` — только для границ, focus-offset и canvas.
- **Адаптивность встроена.** Вёрстка обязана работать на 375px: `min-w-0`, `truncate`, `flex-col sm:flex-row`.
- **Иконки — только через реестр** `@syrnike13/ui/icons` или app-local `components/icons`. Прямые импорты `@remixicon/react`, `@iconify/react`, `iconoir-react`, `lucide-react` внутри shadcn-исходников допустимы только в `icon-placeholder`.
- **Строки интерфейса — только через i18n.** Web: `useTranslations` из `@syrnike13/ui/i18n`, ключи в `apps/web/src/messages/{en,ru}.json`. Admin: `apps/admin/src/messages/{en,ru}.json`. Это касается и `aria-label`, `placeholder`, `title`.
- **Контракты desktop не ломать:** `.dark`, `data-theme`, `data-theme-gradient`, имена семантических CSS-переменных, `.theme-surface-*`, `.gradient-surface-*`, `.shell-title-bar-drag/no-drag`, `data-overlay-panel`, `data-participant-*`, `data-slot="scroll-area-viewport"`, прозрачность overlay, popout-клонирование стилей.

## Добавление компонента из shadcn

1. Возьмите исходник registry `base-nova` (`https://ui.shadcn.com/r/styles/base-nova/<name>.json`).
2. Положите его в `src/primitives/<name>/index.tsx` без изменения разметки и классов.
3. Перепишите импорты: `cn` → `../../lib/cn`, `@/registry/base-nova/ui/<x>` → `../<x>`, `icon-placeholder` → `../icon-placeholder`.
4. Если источник использует палитровые цвета — замените их на семантические токены.
5. Добавьте `usePortalContainer()` в портал, если компонент рендерит overlay.
6. Экспортируйте компонент из `src/index.ts`.
7. Запустите `pnpm check:ui` и `pnpm ui:typecheck`.

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
pnpm check:ui              # правила; baseline только уменьшается
pnpm check:ui:update       # пересчитать baseline после исправлений
pnpm lint:design           # @shadcn/lint по apps; 0 находок, arbitrary/inline запрещены
pnpm ui:typecheck && pnpm web:typecheck && pnpm admin:typecheck
pnpm ui:test && pnpm web:test && pnpm admin:test
pnpm web:build && pnpm admin:build
```

Вид проверяйте в `pnpm web:dev` (:3000) и `pnpm admin:dev` (:3001): light/dark, 375px и desktop, обе Prism-темы, en/ru. Desktop — только `pnpm desktop:dev`. Каталог компонентов — `http://localhost:3000/dev/ui`. В dev-сборке web справа снизу есть **Prism tuning**: живые проценты `surfaceMix`/`raisedMix`, экспорт JSON для переноса значений в `DEFAULT_PRISM_TUNING`.
