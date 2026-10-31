import { cva, type VariantProps } from 'class-variance-authority'
import { Image, View } from 'react-native'

import { cn } from '../../lib/cn'
import { Text } from '../text'

const avatarVariants = cva('items-center justify-center overflow-hidden rounded-full bg-muted', {
  variants: {
    size: {
      xs: 'size-5',
      sm: 'size-6',
      default: 'size-8',
      lg: 'size-10',
      xl: 'size-12',
      '2xl': 'size-24',
    },
  },
  defaultVariants: { size: 'default' },
})

const avatarSizeVariants = cva('', {
  variants: {
    size: { xs: 'size-5', sm: 'size-6', default: 'size-8', lg: 'size-10', xl: 'size-12', '2xl': 'size-24' },
  },
  defaultVariants: { size: 'default' },
})

const fallbackTextVariants = cva('font-medium text-muted-foreground', {
  variants: {
    size: {
      xs: 'text-xs',
      sm: 'text-xs',
      default: 'text-sm',
      lg: 'text-base',
      xl: 'text-lg',
      '2xl': 'text-4xl',
    },
  },
  defaultVariants: { size: 'default' },
})

export type AvatarStatus = 'online' | 'idle' | 'dnd' | 'offline'

/** Status dot: ~30% of the avatar, cut out of its surface by a ring. */
const statusVariants = cva('absolute -right-0.5 -bottom-0.5 rounded-full border-card', {
  variants: {
    status: {
      online: 'bg-success',
      idle: 'bg-warning',
      dnd: 'bg-destructive',
      offline: 'bg-muted-foreground',
    },
    size: {
      xs: 'size-2 border',
      sm: 'size-2.5 border-2',
      default: 'size-3 border-2',
      lg: 'size-3.5 border-2',
      xl: 'size-4 border-2',
      '2xl': 'size-7 border-4',
    },
  },
})

/**
 * Native mirror of `@syrnike13/ui/primitives/avatar`: the image when there is
 * one, otherwise the first letter of the name on a muted circle, with an
 * optional Discord presence dot.
 */
function Avatar({
  className,
  size = 'default',
  src,
  name,
  status,
}: VariantProps<typeof avatarVariants> & {
  className?: string
  src?: string | null
  name: string
  status?: AvatarStatus
}) {
  return (
    // Sized like the avatar so the status dot sits on its corner in any layout.
    <View className={cn('relative', avatarSizeVariants({ size }), className)}>
      <View className={avatarVariants({ size })}>
        {src ? (
          <Image source={{ uri: src }} className="size-full" />
        ) : (
          <Text className={fallbackTextVariants({ size })}>{name.slice(0, 1).toUpperCase()}</Text>
        )}
      </View>
      {status ? <View className={statusVariants({ status, size })} /> : null}
    </View>
  )
}

export { Avatar, avatarVariants }
