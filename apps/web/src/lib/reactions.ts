/** Кодирует emoji для path-сегмента API реакций. */
export function encodeReactionId(emoji: string) {
  return encodeURIComponent(emoji)
}

/** Короткий набор быстрых реакций (полный пикер). */
export const QUICK_REACTIONS = [
  '👍',
  '❤️',
  '😂',
  '😮',
  '😢',
  '🙏',
  '🔥',
  '👀',
  '🎉',
  '💯',
] as const

/** Три эмодзи на плавающей панели при наведении (как в Discord). */
export const HOVER_BAR_REACTIONS = ['👍', '❤️', '😂'] as const
