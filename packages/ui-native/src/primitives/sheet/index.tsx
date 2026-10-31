import type { ReactNode } from 'react'
import { Modal, Pressable, View, type PressableProps, type ViewProps } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { cn } from '../../lib/cn'
import { TextClassContext } from '../text'

/**
 * Native counterpart of `@syrnike13/ui/primitives/sheet` (side "bottom"):
 * Discord's mobile bottom sheet, rounded 24 on top, sliding over a dimmed
 * backdrop that closes it. Content keeps clear of the gesture bar.
 */
function Sheet({
  open,
  onOpenChange,
  closeLabel,
  className,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Accessible name of the backdrop, which closes the sheet. */
  closeLabel: string
  className?: string
  children: ReactNode
}) {
  const insets = useSafeAreaInsets()
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={() => onOpenChange(false)}>
      <View className="flex-1 justify-end">
        <Pressable accessibilityLabel={closeLabel} className="flex-1 bg-background/60" onPress={() => onOpenChange(false)} />
        <View
          className={cn('max-h-3/4 rounded-t-3xl border-t border-border bg-popover pt-2', className)}
          style={{ paddingBottom: insets.bottom + 16 }}
        >
          <View className="mb-2 h-1 w-10 self-center rounded-full bg-muted-foreground/40" />
          {children}
        </View>
      </View>
    </Modal>
  )
}

/** A group of sheet rows on a card, like Discord's grouped actions. */
function SheetGroup({ className, ...props }: ViewProps & { className?: string }) {
  return <View className={cn('mx-4 overflow-hidden rounded-2xl bg-card', className)} {...props} />
}

/**
 * One action row in a `SheetGroup`: 48 tall, a 20 icon then the label.
 * `destructive` tints the label; icons are tinted by the caller.
 */
function SheetItem({
  className,
  destructive = false,
  children,
  ...props
}: Omit<PressableProps, 'children'> & { className?: string; destructive?: boolean; children?: ReactNode }) {
  return (
    <Pressable
      accessibilityRole="button"
      className={cn('h-12 flex-row items-center gap-3 px-4 active:bg-hover', className)}
      {...props}
    >
      <TextClassContext.Provider value={cn('text-base font-medium', destructive && 'text-destructive')}>
        {children}
      </TextClassContext.Provider>
    </Pressable>
  )
}

export { Sheet, SheetGroup, SheetItem }
