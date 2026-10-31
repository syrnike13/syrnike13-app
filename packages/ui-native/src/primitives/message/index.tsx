import type { ComponentProps } from 'react'
import { View, type ViewProps } from 'react-native'

import { cn } from '../../lib/cn'
import { Text } from '../text'

type ClassProps = ViewProps & { className?: string }

/**
 * Native mirror of `@syrnike13/ui/primitives/message`: the Discord cozy chat
 * row. The 72px left gutter holds the 40px avatar at a group start; a group
 * start adds the 17px gap. Touch screens have no hover toolbar, so the right
 * padding is 16px instead of 48px.
 */
function Message({ className, groupStart = false, ...props }: ClassProps & { groupStart?: boolean }) {
  return (
    <View
      className={cn('relative w-full flex-row py-0.5 pr-4 pl-18', groupStart && 'mt-4.25 min-h-11', className)}
      {...props}
    />
  )
}

/** 40px avatar in the gutter. */
function MessageAvatar({ className, ...props }: ClassProps) {
  return <View className={cn('absolute top-0.5 left-4 size-10 overflow-hidden rounded-full', className)} {...props} />
}

function MessageContent({ className, ...props }: ClassProps) {
  return <View className={cn('min-w-0 flex-1', className)} {...props} />
}

/** Author line: name 16/22 w500, then the timestamp 4px apart. */
function MessageHeader({ className, ...props }: ClassProps) {
  return <View className={cn('min-h-5.5 flex-row items-baseline gap-1', className)} {...props} />
}

function MessageAuthor({ className, ...props }: ComponentProps<typeof Text>) {
  return <Text className={cn('text-base leading-5.5 font-medium', className)} numberOfLines={1} {...props} />
}

function MessageTimestamp({ className, ...props }: ComponentProps<typeof Text>) {
  return <Text className={cn('ml-1 text-xs leading-5.5 font-medium text-muted-foreground', className)} {...props} />
}

function MessageText({ className, ...props }: ComponentProps<typeof Text>) {
  return <Text className={cn('text-base leading-5.5', className)} {...props} />
}

export { Message, MessageAuthor, MessageAvatar, MessageContent, MessageHeader, MessageText, MessageTimestamp }
