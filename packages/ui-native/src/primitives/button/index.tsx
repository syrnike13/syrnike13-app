import { cva, type VariantProps } from 'class-variance-authority'
import { Pressable, type PressableProps } from 'react-native'

import { cn } from '../../lib/cn'
import { TextClassContext } from '../text'

/**
 * Native mirror of `@syrnike13/ui/primitives/button`: same variant and size
 * names and the same Discord metrics (sm 32px, default 38px, lg 44px).
 * Hover variants have no touch equivalent; `active:` is the pressed state.
 */
const buttonVariants = cva(
  'flex-row shrink-0 items-center justify-center rounded-lg border border-transparent disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary active:bg-primary/80',
        outline: 'border-border bg-background active:bg-hover',
        secondary: 'bg-secondary active:bg-hover',
        ghost: 'active:bg-hover',
        destructive: 'bg-destructive/20 active:bg-destructive/30',
        link: '',
      },
      size: {
        default: 'h-9.5 gap-2 px-4',
        sm: 'h-8 gap-1.5 rounded-md px-3',
        lg: 'h-11 gap-2 px-5',
        icon: 'size-8',
        'icon-sm': 'size-7 rounded-md',
        'icon-lg': 'size-9',
      },
      shape: {
        default: '',
        circle: 'rounded-full',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
      shape: 'default',
    },
  },
)

const buttonTextVariants = cva('text-sm font-medium', {
  variants: {
    variant: {
      default: 'text-primary-foreground',
      outline: 'text-foreground',
      secondary: 'text-secondary-foreground',
      ghost: 'text-foreground',
      destructive: 'text-destructive',
      link: 'text-primary underline',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
})

type ButtonProps = PressableProps &
  VariantProps<typeof buttonVariants> & { className?: string }

function Button({
  className,
  variant = 'default',
  size = 'default',
  shape = 'default',
  ...props
}: ButtonProps) {
  return (
    <TextClassContext.Provider value={buttonTextVariants({ variant })}>
      <Pressable
        role="button"
        className={cn(buttonVariants({ variant, size, shape }), className)}
        {...props}
      />
    </TextClassContext.Provider>
  )
}

export { Button, buttonVariants, buttonTextVariants, type ButtonProps }
