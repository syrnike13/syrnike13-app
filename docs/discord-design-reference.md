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
| Имя канала в списке | 16px / 24px; weight 400, выбранного — 500 |
| Кнопки | sm 32px, md 38px (CTA на странице — 40px), lg 44px, xl 50px |
| Контролы | `--control-item-height-md: 40px` |
| Радиус кнопок/полей | 8px |

## Каркас

| Элемент | Discord |
| --- | --- |
| Title bar (web) | 32px, padding-right 12px, gap 8px |
| Guild rail | 72px; иконка 40×40, боковые поля 16px; шаг 48px (gap 8px) |
| Колонка каналов | 303px по замеру; список с radius 12px сверху |
| Шапка колонки каналов | 49px, padding 8px; иконка сервера 18px, имя 16px / 20px, weight 600 |
| Список каналов | элемент 286×32px, шаг 34px, padding 4px 8px, radius 8px, icon 20px, текст 16px / 24px; weight 400, у выбранного — 500 |
| Категория | 14px / 18px, weight 500; блок 40px (16px сверху + строка 24px), шеврон 12px справа, текст с отступа 16px; регистр как в названии |
| Разделитель системных групп | 1px, 11px сверху, отступы 16px по бокам; после системных пунктов и после закреплённых каналов, но не между категориями |
| Баннер сервера | 130px; шапка 49px лежит поверх; список начинается ниже видимой части (81px = 130 − 49); при скролле баннер поднимается на 90px и гаснет за 88px |
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
| Композер | область 1264×58px, radius 8px, border 1px, inset 8px |
| Редактор | min-height 56px, 16px / 22px, вертикальные padding 17px; текст с отступа 64px |
| Кнопки композера | 32×32px, иконки 20px, внутренний inset 12px |
| Разделитель даты | margin 24px 14px 8px 16px |

## Как это соотносится с syrnike13

Значения syrnike13 — из `packages/ui/src`, `apps/web/src` и `apps/admin/src`
на момент замера.

### Совпадает

Shell выровнен по живым метрикам Discord:

- сетка 4px (`--spacing: 0.25rem`), rail 72px, иконка 40px, gap 8px, верхний отступ 0;
- колонка каналов 304px (Discord 303px; 1px оставлен, чтобы вместе с member list
  264px контент был ровно 1280px);
- шапка колонки 49px, padding 8px, имя сервера 16/20 w600;
- строка канала 32px, шаг 34px, padding 4/8, radius 8px, icon 20px, текст 16/24,
  w500 у всех каналов;
- категория: блок 40px, текст 14/18 w500, отступ 16px, шеврон 12px справа,
  без принудительного uppercase; отступ между категориями даёт сама категория;
- баннер сервера 130px, шапка 49px поверх, при скролле уезжает на 90px и
  гаснет за 88px;
- member list 264px;
- плавающие панели: inset 8px, высота 58px (56px + ring), bottom 8px,
  охват rail+sidebar, radius 8px;
- user panel: padding 12px, avatar 32px, имя 16/18 w500, статус 12/13 w500,
  controls 32px, split 49px, gap 8px;
- композер: 1264×58px, editor min-height 56px, padding 17px 0, 16/22,
  buttons 32px/icon 20px, внутренний inset 12px;
- title bar web и Electron Windows 32px;
- сообщение 16/22, timestamp 12/22, avatar 40px, member avatar 32px,
  group start 17px.

### Осознанные отличия

| Параметр | syrnike13 | Discord | Причина |
| --- | --- | --- | --- |
| Основной шрифт | Nunito Sans | gg sans | Брендовый шрифт |
| Вес названия канала | 500 у всех | 400, у выбранного — 500 | По решению продукта вес не меняется от активности |
| Трекинг подписей | -0.025em (`tracking-tight`) | normal | Nunito Sans шире gg sans; так ширина строк совпадает |
| Иконка сервера в шапке | нет | 18px | По решению продукта |
| Glyph рельса | 18px | 24px | Кнопка 40px совпадает, глиф меньше |
| Ширина колонки | 304px | 303px | Ровные 1280px контента |
| Разделитель системных групп | нет | 1px после закреплённых/системных пунктов | Системного блока пока нет; между категориями линии нет и в Discord |
| Вес имени автора | 600 | 500 | Размер 16/22 совпадает |
| Кнопки (primitives) | 32 default, 28 sm, 36 lg | 32 sm, 38 md, 44 lg, 50 xl | Нет md/lg/xl Discord |
| Input primitive | 32px, radius 10px | 40px control, radius 8px | Композер использует свой editor |
| Textarea primitive | min-height 64px, radius 10px | min-height 56px, radius 8px | Композер использует свой editor |
| Радиусы (общая шкала) | 6/8/10/14px | 4/8/12/16/24px | Shell использует 12px и 8px |
| Hover-панель сообщения | 32px | 28px | |
| Правый блок композера | только emoji 32px | ~192px (GIF/sticker/emoji) | Текстовая область шире |
| Форма плавающих панелей | Squircle smoothing 1 | CSS round 8px | Радиус совпадает, форма мягче |

### Что осталось из старых различий

- Общая шкала радиусов примитивов и размеры Button/Input/Textarea.
- Hover-панель сообщения.
- Правый блок кнопок композера.
- Вес имени автора 600 vs 500.
- Glyph рельса 18 vs 24.
- Разделитель после системного блока (появится вместе с ним).

Массовую миграцию примитивов не выполняли; shell, колонка каналов, user panel
и композер выровнены по Discord.

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
