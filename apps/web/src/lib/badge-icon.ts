export const badgeIconSizeClass = {
  /** Компактные профили: меню пользователя, узкая карточка */
  sm: 'size-5',
  /** Профиль в поповере и глобальная боковая панель */
  md: 'size-6',
  /** Крупная иконка в тултипе */
  tooltip: 'size-7',
} as const

export type BadgeIconSize = keyof typeof badgeIconSizeClass
