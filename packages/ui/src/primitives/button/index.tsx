import { Button as ButtonPrimitive } from '@base-ui/react/button'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'

/**
 * shadcn/ui Base UI button (registry style `base-nova`).
 *
 * The base classes, standard variants and the `ButtonPrimitive` wrapper come
 * from the upstream registry. Product variants and the denser size scale are
 * syrnike extensions kept below the upstream entries.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // Upstream shadcn variants.
        default: 'bg-primary text-primary-foreground hover:bg-primary/80',
        outline:
          'border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50',
        secondary:
          // design-allow arbitrary-color: literal shadcn base-nova secondary variant
          'bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground',
        ghost:
          'hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50',
        destructive:
          'bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40',
        link: 'text-primary underline-offset-4 hover:underline',

        // syrnike product variants.
        success: 'bg-success text-on-solid hover:bg-success/90',
        quiet:
          'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
        'destructive-ghost':
          'text-muted-foreground hover:bg-destructive/15 hover:text-destructive',
        'media-ghost':
          'text-on-media/80 hover:bg-on-media/10 hover:text-on-media',
        'media-ghost-active':
          'bg-on-media/15 text-on-media hover:bg-on-media/20',
        'media-outline':
          'border border-on-media/20 bg-transparent text-on-media hover:bg-on-media/10',
        scrim: 'bg-scrim text-on-scrim hover:opacity-80',
        'scrim-icon': 'rounded-full bg-scrim text-on-scrim hover:opacity-80',
        floating: 'bg-background/60 text-foreground hover:bg-background/80',
        'floating-outline':
          'border border-border/60 bg-background/80 text-foreground shadow-sm backdrop-blur-sm hover:bg-background',
        inverse: 'bg-foreground text-background hover:opacity-90',
        'outline-ghost':
          'border border-border/50 bg-transparent text-muted-foreground hover:border-border hover:text-foreground',
        toolbar:
          'rounded-md text-muted-foreground hover:bg-muted hover:text-foreground',
        'toolbar-active':
          'rounded-md bg-primary/15 text-foreground ring-1 ring-primary/30',
        'reaction-active':
          'border border-primary/70 bg-primary/30 text-foreground shadow-none hover:bg-primary/40 dark:border-primary/70 dark:bg-primary/30 dark:hover:bg-primary/40',
        'tile-action':
          'rounded-sm text-muted-foreground hover:bg-foreground/10 hover:text-foreground',
        'tile-action-primary':
          'rounded-sm text-primary hover:bg-foreground/10 hover:text-primary',
        'tile-action-destructive':
          'rounded-sm text-destructive hover:bg-destructive/15 hover:text-destructive',
        'icon-ghost':
          'rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground',
      },
      size: {
        default:
          'h-9 gap-2 px-4 py-2 has-data-[icon=inline-start]:pl-3 has-data-[icon=inline-end]:pr-3',
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-data-[icon=inline-start]:pl-1.5 has-data-[icon=inline-end]:pr-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-data-[icon=inline-start]:pl-2.5 has-data-[icon=inline-end]:pr-2.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-10 rounded-md px-6 has-data-[icon=inline-start]:pl-4 has-data-[icon=inline-end]:pr-4',
        icon: 'size-9',
        'icon-xs': "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-8',
        'icon-lg': 'size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Button({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
