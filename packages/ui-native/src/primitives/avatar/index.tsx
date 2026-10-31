import { cva, type VariantProps } from 'class-variance-authority'
import { Image, View } from 'react-native'

import { cn } from '../../lib/cn'
import { Text } from '../text'

const avatarVariants = cva('items-center justify-center overflow-hidden rounded-full bg-muted', {
  variants: {
    size: {
      sm: 'size-6',
      default: 'size-8',
      lg: 'size-10',
      xl: 'size-12',
    },
  },
  defaultVariants: { size: 'default' },
})

const fallbackTextVariants = cva('font-medium text-muted-foreground', {
  variants: {
    size: { sm: 'text-xs', default: 'text-sm', lg: 'text-base', xl: 'text-lg' },
  },
  defaultVariants: { size: 'default' },
})

/**
 * Native mirror of `@syrnike13/ui/primitives/avatar`: the image when there is
 * one, otherwise the first letter of the name on a muted circle.
 */
function Avatar({
  className,
  size = 'default',
  src,
  name,
}: VariantProps<typeof avatarVariants> & { className?: string; src?: string | null; name: string }) {
  return (
    <View className={cn(avatarVariants({ size }), className)}>
      {src ? (
        <Image source={{ uri: src }} className="size-full" />
      ) : (
        <Text className={fallbackTextVariants({ size })}>{name.slice(0, 1).toUpperCase()}</Text>
      )}
    </View>
  )
}

export { Avatar, avatarVariants }
