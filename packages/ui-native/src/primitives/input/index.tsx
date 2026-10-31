import { cva, type VariantProps } from 'class-variance-authority'
import { Platform, TextInput, type TextInputProps } from 'react-native'
import { useResolveClassNames } from 'uniwind'

import { cn } from '../../lib/cn'

const inputVariants = cva('w-full text-base text-foreground outline-none', {
  variants: {
    variant: {
      default: 'h-10 rounded-lg border border-input bg-input/30 px-3 focus:border-ring/50',
      // Inside a surface that already draws the field (the chat composer pill).
      bare: 'min-h-10 px-1 py-2',
    },
  },
  defaultVariants: { variant: 'default' },
})

// react-native-web renders a multiline field as a two-row textarea; start it
// at one row like Android, so the composer pill keeps its 58dp height.
const webSingleRow = Platform.OS === 'web' ? ({ rows: 1 } as Partial<TextInputProps>) : {}

/** Native mirror of `@syrnike13/ui/primitives/input`: Discord field metrics, 40px, 16px text. */
function Input({
  className,
  variant = 'default',
  ...props
}: TextInputProps & VariantProps<typeof inputVariants> & { className?: string }) {
  // Placeholder colour is a prop, not a style, on React Native.
  const placeholder = useResolveClassNames('text-muted-foreground')
  return (
    <TextInput
      className={cn(inputVariants({ variant }), className)}
      placeholderTextColor={placeholder.color as string | undefined}
      {...(props.multiline ? webSingleRow : {})}
      {...props}
    />
  )
}

export { Input, inputVariants }
