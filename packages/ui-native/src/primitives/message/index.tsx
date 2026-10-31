import type { ComponentProps, ReactNode } from 'react'
import { Pressable, View, type PressableProps, type ViewProps } from 'react-native'

import { cn } from '../../lib/cn'
import { Text, TextClassContext } from '../text'

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

/**
 * System row glyph in the avatar column, centred on the first text line. Icons
 * do not inherit text colour in React Native, so the caller tints the icon.
 */
function MessageIcon({ className, ...props }: ClassProps) {
  return (
    <View
      aria-hidden
      className={cn('absolute top-0.5 left-3 h-5.5 w-10 items-center justify-center', className)}
      {...props}
    />
  )
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

/** Muted inline note after the text, e.g. "(edited)"; nest it in `MessageText`. */
function MessageNote({ className, ...props }: ComponentProps<typeof Text>) {
  return <Text className={cn('text-xs text-muted-foreground', className)} {...props} />
}

/**
 * Reply quote above the author line (14/18): the replied author and a one-line
 * excerpt. The spine curls from the avatar column into the quote.
 */
function MessageReply({
  className,
  children,
  ...props
}: Omit<PressableProps, 'children'> & { className?: string; children?: ReactNode }) {
  return (
    <Pressable className={cn('relative mb-1 h-4.5 flex-row items-center gap-1', className)} {...props}>
      <View className="absolute top-2.25 right-full -bottom-1 mr-1 w-9 rounded-tl-md border-t-2 border-l-2 border-muted-foreground/40" />
      <TextClassContext.Provider value="text-sm leading-4.5 text-muted-foreground">{children}</TextClassContext.Provider>
    </Pressable>
  )
}

/** Attachments and embeds under the text, 8dp apart. */
function MessageAttachments({ className, ...props }: ClassProps) {
  return <View className={cn('mt-1 gap-2', className)} {...props} />
}

/** A rounded media frame; the caller sizes it from the file's aspect ratio. */
function MessageAttachment({ className, ...props }: ClassProps) {
  return <View className={cn('max-w-full overflow-hidden rounded-xl bg-muted', className)} {...props} />
}

function MessageReactions({ className, ...props }: ClassProps) {
  return <View className={cn('mt-1 flex-row flex-wrap items-center gap-1', className)} {...props} />
}

/**
 * Reaction chip, Discord mobile size: 30dp tall, emoji 20 and count 14.
 * `pressed` means the current user reacted and draws the primary outline.
 */
function MessageReaction({
  className,
  pressed = false,
  ...props
}: PressableProps & { className?: string; pressed?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: pressed }}
      className={cn(
        'h-7.5 flex-row items-center gap-1.5 rounded-lg border border-transparent bg-secondary px-2 active:bg-hover',
        pressed && 'border-primary bg-primary/15',
        className,
      )}
      {...props}
    />
  )
}

/** Count inside `MessageReaction`. */
function MessageReactionCount({ className, ...props }: ComponentProps<typeof Text>) {
  return <Text className={cn('text-sm font-semibold text-muted-foreground', className)} {...props} />
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
  MessageAttachment,
  MessageAttachments,
  MessageAuthor,
  MessageAvatar,
  MessageContent,
  MessageDivider,
  MessageHeader,
  MessageIcon,
  MessageNote,
  MessageReaction,
  MessageReactionCount,
  MessageReactions,
  MessageReply,
  MessageText,
  MessageTimestamp,
}
