/** Горизонтальные отступы article сообщения (см. -mx-4 у строки). */
export const MESSAGE_ROW_PADDING_X = 'px-6' as const

/** Ширина колонки аватара + gap до текста (w-10 + gap-4). */
export const MESSAGE_AVATAR_COLUMN = 'w-10 shrink-0' as const

/** Отступ текста в «хвосте» группы = padding + аватар + gap (1.5 + 2.5 + 1 = 5rem). */
export const MESSAGE_COMPACT_CONTENT_INSET = 'pl-20 pr-6' as const

/** Позиция времени при hover на compact-сообщении (над колонкой аватара). */
export const MESSAGE_COMPACT_TIME_CLASS =
  'pointer-events-none absolute top-0.5 left-6 z-[1] hidden w-10 text-center text-[11px] leading-4 font-medium text-muted-foreground group-hover:block' as const
