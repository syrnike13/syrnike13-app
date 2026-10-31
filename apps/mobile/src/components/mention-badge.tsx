import { Text } from '@syrnike13/ui-native/primitives/text'
import { View } from 'react-native'

import { cn } from '@syrnike13/ui-native/lib/cn'

/**
 * Discord's red mention count: white bold digits in a pill ringed with the
 * background colour, so it reads over avatars and icons. Hidden at zero.
 */
export function MentionBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null
  return (
    <View
      className={cn(
        'absolute min-w-5 items-center rounded-full border-2 border-background bg-destructive px-1',
        className,
      )}
    >
      <Text className="text-xs font-bold text-destructive-foreground">{count > 99 ? '99+' : count}</Text>
    </View>
  )
}
