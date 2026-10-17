# Дизайн syrnike13

Визуальный тезис: тёплый пиксельный мессенджер, собранный из слоистых полупрозрачных поверхностей. Интерфейс плотный, но спокойный: крупные акценты только у действий и статусов, фон и хром отступают назад.

## Характер

- **Тёплый пиксельный**: скругления умеренные (`rounded-md`/`rounded-lg`), без squircle-идентичности; пиксельные детали — в логотипе, бейджах и декоративных элементах.
- **Коралловый destructive, индиго primary**: бренд-цвета фиксированы и не участвуют в генерации тем.
- **21 тема**: `syrnike`, `lug`, `iskra`, `matrix`, `monolit`, `pergament`, `grafit`, `kontrast`, 12 градиентных тем и кастомный градиент. Тема задаёт якоря, из которых выводятся семантические токены; названия и описания живут в `themes.<id>` каталогов `en`/`ru`.
- **Свет и тьма**: у каждой темы есть варианты `light`/`dark` (если поддерживаются). Переключение мгновенное, без вспышки: bootstrap-стиль в `__root` применяется до гидратации.
- **Слои**: `background` → `card` → `popover`/`muted`; хром чата использует `shell-*`, оверлеи — `scrim`/`on-scrim`, медиа — `media-backdrop`/`on-media`.

## Типографика

- Заголовки и плотные метки: **Space Grotesk**; основной текст: **Nunito Sans**.
- Шкала по умолчанию Tailwind: `text-xs` 12px, `text-sm` 14px, `text-base` 16px. Промежуточные размеры — только в rem (`text-[0.8125rem]`, `text-[0.6875rem]`), не в px.
- Заголовки экранов — `text-lg`/`text-xl` с `font-semibold`; метаданные — `text-xs text-muted-foreground`.
- Числа в таблицах и таймерах — `tabular-nums`.

## Поверхности

- Примитивы владеют фоном, рамкой, тенью, радиусом и состояниями. На месте вызова — только layout и текстовые токены.
- Стеклянные/слоистые поверхности: `bg-card/50`, `bg-background/80`, `backdrop-blur-sm` только для плавающего хрома.
- Разделители — `border-border/60`, не тени.
- На медиа-поверхностях используйте `on-media` и `bg-media-backdrop`, а не `white`/`black`.

## Плотность и движение

- Базовые контролы: 36px (`h-9`), компактные — 32px (`h-8`), мобильные — не меньше 44px по touch-таргету.
- Отступы кратны 4px; секции — `gap-4`/`gap-5`, внутри карточек — `p-4`.
- Переходы 150–200ms, только `color`, `background-color`, `opacity`, `transform`. Уважайте `prefers-reduced-motion`.
- Диалоги и меню анимируются через `data-[state=open/closed]`, без ручных таймеров.

## Адаптивность

- Верстка работает от 375px: `min-w-0`, `truncate`, `flex-col sm:flex-row`, container queries вместо JS-ветвлений по ширине.
- Мобильные маршруты `/m/*` собирают `Sheet`/`Drawer`, учитывают `safe-area-inset-*` и не дублируют десктопный layout.
- Ввод, textarea и пункты меню сами увеличиваются на узком экране.

## Локализация и темы

- UI-строки — только через `useTranslations`; `en`/`ru` каталоги в `apps/{web,admin}/src/messages`.
- Локаль хранится в настройках и localStorage (`syrnike13-locale`), без префикса URL; `document.documentElement.lang` обновляется.
- Числа, даты и плюрализация — через `Intl` и ICU-lite плюрализацию рантайма.
- Имена тем, статусы, ошибки и aria-подписи переводятся наравне с обычным текстом; технические идентификаторы — нет.

## Контракты desktop

- `.dark`, `data-theme`, `data-theme-gradient`, `.theme-surface-*`, `.gradient-surface-*`, `.shell-title-bar-drag/no-drag`, `data-overlay-panel`, `data-participant-*`, `data-slot="scroll-area-viewport"`, прозрачность overlay и popout-клонирование стилей не переименовывать.
- Фон Electron — `#3d3a48` для темы `syrnike/dark`; проверяется contract-тестом.
- Оверлей: ширина панели 296px (18.5rem), прозрачные `html`/`body`, без фона панели.

## Проверка

```sh
pnpm check:ui
pnpm check:messages
pnpm ui:typecheck && pnpm web:typecheck && pnpm admin:typecheck
pnpm ui:test && pnpm web:test && pnpm admin:test
pnpm web:build && pnpm admin:build
```

Визуально: 375px и desktop, light/dark/system, все 21 тема, `en`/`ru`, Electron-оверлей и popout.
