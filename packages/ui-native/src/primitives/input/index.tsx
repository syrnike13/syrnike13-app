import { TextInput, type TextInputProps } from 'react-native'
import { useResolveClassNames } from 'uniwind'

import { cn } from '../../lib/cn'

/** Native mirror of `@syrnike13/ui/primitives/input`: Discord field metrics, 40px, 16px text. */
function Input({ className, ...props }: TextInputProps & { className?: string }) {
  // Placeholder colour is a prop, not a style, on React Native.
  const placeholder = useResolveClassNames('text-muted-foreground')
  return (
    <TextInput
      className={cn(
        'h-10 w-full rounded-lg border border-input bg-input/30 px-3 text-base text-foreground focus:border-ring/50',
        className,
      )}
      placeholderTextColor={placeholder.color as string | undefined}
      {...props}
    />
  )
}

export { Input }
