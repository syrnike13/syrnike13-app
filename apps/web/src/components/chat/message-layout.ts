/** Строка сообщения (cozy): 2px 24px 2px 72px. */
export const MESSAGE_ROW_CLASS =
  'group relative flex w-full min-w-0 items-start gap-4 py-0.5 pr-6 pl-18'

/** Старт группы сообщений одного автора. */
export const MESSAGE_GROUP_START_CLASS = 'mt-4.25'

/** Продолжение группы: без аватара и заголовка. */
export const MESSAGE_COMPACT_ROW_CLASS = 'min-h-5.5'

/** Аватар 40px в левой колонке строки (16px от края). */
export const MESSAGE_AVATAR_CLASS = 'absolute top-0.5 left-4 w-10'

/** Время продолжения группы — по hover в колонке аватара. */
export const MESSAGE_COMPACT_TIME_CLASS =
  'pointer-events-none absolute top-0.5 left-4 z-1 w-10 text-center text-xs leading-5.5 font-medium text-muted-foreground opacity-0 group-hover/message:opacity-100'
