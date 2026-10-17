# Discord design reference

Живые метрики Discord Web, снятые через Chrome DevTools Protocol 2026-10-18.
Условия замера: Chrome 155, окно 1920×945, тема dark, плотность `density-default`
(cozy), `font-size-16`, locale ru. Значения — computed styles реальных элементов,
а не догадки из скриншотов. Discord меняет вёрстку между релизами: при
расхождении перемеряйте, а не подгоняйте код под устаревшую цифру.

Шрифт Discord (`gg sans`) проприетарный. Совпадать имеет смысл с размерами,
межстрочными интервалами и геометрией, а не с файлом шрифта.

## Токены размеров

| Параметр | Discord |
| --- | --- |
| Базовая сетка отступов | 4px |
| Spacing-токены | 4, 8, 12, 16, 20, 24, 32, 40, 64, 80px |
| Radius | `xs` 4px, `sm` 8px, `md` 12px, `lg` 16px, `xl` 24px |
| Высота текста чата | 16px / 22px (`--chat-markup-line-height: 1.375rem`) |
| Мелкий текст | 14px / 18px |
| Метаданные | 12px / 22px |
| Заголовок канала | 16px / 20px, weight 500 |
| Имя канала в списке | 16px / 24px, weight 500 |
| Кнопки | sm 32px, md 38px (CTA на странице — 40px), lg 44px, xl 50px |
| Контролы | `--control-item-height-md: 40px` |
| Радиус кнопок/полей | 8px |

## Каркас

| Элемент | Discord |
| --- | --- |
| Title bar (web) | 32px, padding-right 12px, gap 8px |
| Guild rail | 72px; иконка 40×40, боковые поля 16px; шаг 48px (gap 8px) |
| Колонка каналов | 303px по замеру; список с radius 12px сверху |
| Шапка колонки каналов | 49px, padding 8px |
| Список каналов | элемент 286×32px, padding 4px 8px, radius 8px, icon 20px |
| Категория | 16px / 24px, weight 500 |
| Member list | 264px; строка 248×42px, margin-left 8px, radius 8px |
| Аватар в member list | 32px |
| Группа участников | 14px / 18px, weight 500; padding 20px 4px 4px 16px |
| Заголовок канала | 49px, padding 8px 8px 8px 16px |

## Чат

| Элемент | Discord |
| --- | --- |
| Контейнер сообщения (cozy) | padding 2px 24px 2px 72px |
| Старт группы | margin-top 17px, min-height 44px |
| Аватар сообщения | 40×40px, margin-top 2px |
| Имя автора | 16px / 22px, weight 500 |
| Текст сообщения | 16px / 22px, weight 400 |
| Timestamp | 12px / 22px, weight 500, margin-left 4px |
| Reply-превью | 14px / 18px |
| Hover-панель | кнопка 28×28px (24px + 2px padding), radius 6px |
| Композер | область 1264×58px, radius 8px, border 1px |
| Редактор | min-height 56px, 16px / 22px, вертикальные padding 17px |
| Кнопки композера | 32×32px, gap 8px |
| Разделитель даты | margin 24px 14px 8px 16px |

## Как это соотносится с syrnike13

Значения syrnike13 — из `packages/ui/src`, `apps/web/src` и `apps/admin/src`
на момент замера.

### Совпадает

- Сетка отступов 4px (`--spacing: 0.25rem`).
- Ширина guild rail 72px (`w-18`).
- Аватар сообщения 40px (`size-10`).
- Аватар участника 32px (`size-8`).
- Старт группы сообщений 17px (`mt-[1.0625rem]`).
- Высота title bar Electron 32px на Windows.
- Высота шапок колонок 48px против 49px у Discord — расхождение в 1px.

### Отличается

| Параметр | syrnike13 | Discord | Комментарий |
| --- | --- | --- | --- |
| Основной шрифт | Nunito Sans | gg sans | Брендовое решение; менять только осознанно |
| Текст сообщения | 15px / ~20.6px (`text-[0.9375rem] leading-snug`) | 16px / 22px | Меньше и плотнее |
| Timestamp | 11px (`text-[0.6875rem]`) | 12px / 22px | Меньше |
| Reply-превью | 13px (`text-[0.8125rem]`) | 14px / 18px | Меньше |
| Имя автора | наследует 16px | 16px / 22px, weight 500 | Размер совпадает, вес/интерлиньяж нет |
| Элемент канала | 36px, 14px text, icon 16px | 32px, 16px text, icon 20px | Выше и мельче |
| Категория каналов | 11px, uppercase, semibold | 16px / 24px, weight 500 | Заметно мельче |
| Колонка каналов | 328px (`w-82`) | 303px | Шире на 25px |
| Member list | 208px (`w-52`) | 264px | Уже на 56px |
| Имя участника | 14px / 20px, medium | 16px / 20px, weight 500 | Мельче |
| Группа участников | 11px, uppercase, semibold | 14px / 18px, weight 500 | Мельче и другой регистр |
| Rail-иконка | 44px (`size-11`) | 40px | Крупнее |
| Кнопки | 32px default, 28px sm, 36px lg | 32px sm, 38px md, 44px lg, 50px xl | Нет среднего и крупного размеров Discord |
| Input | 32px, radius 10px | 40px control, radius 8px | Ниже и более скруглённый |
| Textarea | min-height 64px, radius 10px | min-height 56px, radius 8px | Выше и более скруглённая |
| Композер | редактор min-height 36px, 14px / 20px на desktop | min-height 56px, 16px / 22px | Существенно плотнее |
| Радиусы | 6 / 8 / 10 / 14px | 4 / 8 / 12 / 16 / 24px | Другая шкала |
| Hover-панель сообщения | 32px | 28px | Крупнее |

### Выводы для миграции

1. **Текст чата** — самый заметный разрыв: 15px/20.6 → 16px/22. Это меняет
   плотность всей ленты; проверять на 375px и desktop.
2. **Список каналов** — 36px/14px/16px → 32px/16px/20px. Уменьшение высоты
   строки при увеличении шрифта требует проверки truncate и длинных названий.
3. **Member list** — 208 → 264px и 14px → 16px. Проверить, что чат не
   становится слишком узким на 1280px и 1024px.
4. **Композер** — 36 → 56px и 14/20 → 16/22. Самый рискованный пункт для
   мобильной вёрстки и Electron-оверлея.
5. **Кнопки/поля** — ввести размеры Discord (32/38/44/50) и радиус 8px вместо
   10px; не менять все вызовы сразу, а добавить размеры в примитивы.
6. **Категории и группы участников** — убрать uppercase и 11px в пользу
   14–16px normal/medium.
7. **Шкалу радиусов** привести к 4/8/12/16/24; текущие 6/8/10/14 — другая
   система.

Массовую миграцию размеров в этом изменении не выполняли: сначала нужен
визуальный прогон light/dark, обеих Prism-тем, 375px/desktop, en/ru и
Electron-оверлея. Справочник фиксирует целевые значения, чтобы миграция была
механической и проверяемой.

## Линтер

`@shadcn/lint` подключён в `eslint.config.mjs`, команда — `pnpm lint:design`.

- Проверяются `apps/web/src` и `apps/admin/src`.
- `packages/ui/src/primitives` исключён: это literal shadcn base-nova sources,
  их проверяет `pnpm check:ui`.
- `no-restyle` выключен: точную политику репозитория (layout + текстовые
  токены) уже проверяет `tooling/scripts/check-ui.mjs`.
- Включены `no-arbitrary-values`, `no-raw-colors`, `no-unknown-classes`,
  `require-static-classes`, `no-inline-styles`.
- Существующие нарушения зафиксированы в `eslint-suppressions.json`; новые
  нарушения валят команду. После миграции baseline удалён: `pnpm lint:design`
  должен проходить с 0 находок. `--suppress-all` не использовать; осознанное
  исключение — точечный `eslint-disable-next-line <rule> -- <причина>`.
- Алиас `tv` для `useTranslations` переименован в `tValidation`/`tVoice`:
  `tv` — встроенная функция tailwind-variants, и линтер принимал ключи
  переводов за классы.
