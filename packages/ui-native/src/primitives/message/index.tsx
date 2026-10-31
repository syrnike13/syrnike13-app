import type { ComponentProps } from 'react'
import { View, type ViewProps } from 'react-native'

import { cn } from '../../lib/cn'
import { Text } from '../text'

type ClassProps = ViewProps & { className?: string }

/**
 * Native mirror of `@syrnike13/ui/primitives/message`: the Discord cozy chat
 * row with Discord *mobile* metrics. The 40dp avatar sits 12dp from the edge,
 * text starts at 64dp and ends 12dp from the right; a group start adds the
 * 17px gap. Touch screens have no hover toolbar.
 */
function Message({ className, groupStart = false, ...props }: ClassProps & { groupStart?: boolean }) {
  return (
    <View
      className={cn('relative w-full flex-row py-0.5 pr-3 pl-16', groupStart && 'mt-4.25 min-h-11', className)}
      {...props}
    />
  )
}

/** 40px avatar in the gutter. */
function MessageAvatar({ className, ...props }: ClassProps) {
  return <View className={cn('absolute top-0.5 left-3 size-10 overflow-hidden rounded-full', className)} {...props} />
}

function MessageContent({ className, ...props }: ClassProps) {
  return <View className={cn('min-w-0 flex-1', className)} {...props} />
}

/** Author line: name 16/22 w500, then the timestamp 8px apart. */
function MessageHeader({ className, ...props }: ClassProps) {
  return <View className={cn('min-h-5.5 flex-row items-baseline gap-2', className)} {...props} />
}

function MessageAuthor({ className, ...props }: ComponentProps<typeof Text>) {
  return <Text className={cn('shrink text-base leading-5.5 font-medium', className)} numberOfLines={1} {...props} />
}

function MessageTimestamp({ className, ...props }: ComponentProps<typeof Text>) {
  return <Text className={cn('text-xs leading-5.5 font-medium text-muted-foreground', className)} {...props} />
}

function MessageText({ className, ...props }: ComponentProps<typeof Text>) {
  return <Text className={cn('text-base leading-5.5', className)} {...props} />
}

/** Day separator: a centred label between two hairlines. */
function MessageDivider({ className, label }: { className?: string; label: string }) {
  return (
    <View className={cn('mt-4 flex-row items-center gap-2 px-3', className)}>
      <View className="h-px flex-1 bg-border" />
      <Text className="text-sm font-medium text-muted-foreground">{label}</Text>
      <View className="h-px flex-1 bg-border" />
    </View>
  )
}

export {
  Message,
  MessageAuthor,
  MessageAvatar,
  MessageContent,
  MessageDivider,
  MessageHeader,
  MessageText,
  MessageTimestamp,
}
