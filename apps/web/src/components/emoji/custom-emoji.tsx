import { FxImage } from '#/components/ui/fx-image'
import { customEmojiImageUrl } from '#/lib/emoji'
import { cn } from '#/lib/utils'

type CustomEmojiProps = {
  emojiId: string
  name?: string
  className?: string
  /** sm 16px, md 20px, lg 28px (picker grid), xl 40px (picker preview). */
  size?: 'sm' | 'md' | 'lg' | 'xl'
}

export function CustomEmoji({
  emojiId,
  name,
  className,
  size = 'md',
}: CustomEmojiProps) {
  const sizeClass = cn(
    size === 'sm' && 'size-4',
    size === 'md' && 'size-5',
    size === 'lg' && 'size-7',
    size === 'xl' && 'size-10',
  )

  return (
    <FxImage
      src={customEmojiImageUrl(emojiId)}
      alt={name ? `:${name}:` : 'emoji'}
      title={name ? `:${name}:` : undefined}
      wrapperAs="span"
      wrapperClassName={cn('inline-block align-text-bottom', sizeClass, className)}
      className={sizeClass}
      draggable={false}
    />
  )
}
