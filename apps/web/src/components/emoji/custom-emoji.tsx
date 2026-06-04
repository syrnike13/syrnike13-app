import { customEmojiImageUrl } from '#/lib/emoji'
import { cn } from '#/lib/utils'

type CustomEmojiProps = {
  emojiId: string
  name?: string
  className?: string
  size?: 'sm' | 'md'
}

export function CustomEmoji({
  emojiId,
  name,
  className,
  size = 'md',
}: CustomEmojiProps) {
  const px = size === 'sm' ? 'size-4' : 'size-5'

  return (
    <img
      src={customEmojiImageUrl(emojiId)}
      alt={name ? `:${name}:` : 'emoji'}
      title={name ? `:${name}:` : undefined}
      className={cn('inline-block align-text-bottom object-contain', px, className)}
      loading="lazy"
      draggable={false}
    />
  )
}
