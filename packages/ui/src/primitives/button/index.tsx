import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "../../lib/cn"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        "outline-ghost":
          "border border-border/50 bg-transparent text-muted-foreground hover:border-border hover:text-foreground",
        inverse: "bg-foreground text-background hover:opacity-90",
        success: "bg-success text-on-solid hover:bg-success/90",
        quiet:
          "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
        "destructive-ghost":
          "text-muted-foreground hover:bg-destructive/15 hover:text-destructive",
        "media-ghost":
          "text-on-media/80 hover:bg-on-media/10 hover:text-on-media",
        "media-ghost-active":
          "bg-on-media/15 text-on-media hover:bg-on-media/20",
        "media-outline":
          "border border-on-media/20 bg-transparent text-on-media hover:bg-on-media/10",
        floating: "bg-background/60 text-foreground hover:bg-background/80",
        "floating-outline":
          "border border-border/60 bg-background/80 text-foreground shadow-sm backdrop-blur-sm hover:bg-background",
        scrim: "bg-scrim text-on-scrim hover:opacity-80",
        toolbar:
          "rounded-md text-muted-foreground hover:bg-muted hover:text-foreground",
        "toolbar-active":
          "rounded-md bg-primary/15 text-foreground ring-1 ring-primary/30",
        "reaction-active":
          "border border-primary/70 bg-primary/30 text-foreground shadow-none hover:bg-primary/40 dark:border-primary/70 dark:bg-primary/30 dark:hover:bg-primary/40",
        "tile-action":
          "rounded-sm text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
        "tile-action-primary":
          "rounded-sm text-primary hover:bg-foreground/10 hover:text-primary",
        "tile-action-destructive":
          "rounded-sm text-destructive hover:bg-destructive/15 hover:text-destructive",
        "icon-ghost":
          "rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
