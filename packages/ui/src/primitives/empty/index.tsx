import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../../lib/cn"

/**
 * The one empty state. Not in base-nova: `size` adapts it to where it sits
 * (a whole column, a panel, a popover or a line inside a section) and
 * `variant="card"` gives it a surface. Call sites pass no styling.
 */
const emptyVariants = cva(
  "group/empty flex w-full min-w-0 flex-col items-center justify-center text-center text-balance",
  {
    variants: {
      size: {
        page: "flex-1 gap-4 p-12",
        default: "gap-3 px-4 py-8",
        sm: "gap-2 p-3",
        inline: "items-start gap-1 p-0 text-left",
      },
      variant: {
        default: "",
        card: "rounded-lg bg-card p-4 text-card-foreground ring-1 ring-foreground/10",
      },
    },
    defaultVariants: {
      size: "default",
      variant: "default",
    },
  }
)

function Empty({
  className,
  size = "default",
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof emptyVariants>) {
  return (
    <div
      data-slot="empty"
      data-size={size}
      data-variant={variant}
      className={cn(emptyVariants({ size, variant }), className)}
      {...props}
    />
  )
}

function EmptyHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-header"
      className={cn(
        "flex max-w-sm flex-col items-center gap-1 group-data-[size=inline]/empty:items-start group-data-[size=page]/empty:gap-2",
        className
      )}
      {...props}
    />
  )
}

const emptyMediaVariants = cva(
  "mb-2 flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        icon: "flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground group-data-[size=page]/empty:size-12 group-data-[size=page]/empty:rounded-xl [&_svg:not([class*='size-'])]:size-4 group-data-[size=page]/empty:[&_svg:not([class*='size-'])]:size-6",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function EmptyMedia({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof emptyMediaVariants>) {
  return (
    <div
      data-slot="empty-icon"
      data-variant={variant}
      className={cn(emptyMediaVariants({ variant, className }))}
      {...props}
    />
  )
}

function EmptyTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-title"
      className={cn(
        "cn-font-heading text-sm font-medium tracking-tight group-data-[size=page]/empty:text-lg group-data-[size=page]/empty:font-semibold",
        className
      )}
      {...props}
    />
  )
}

function EmptyDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <div
      data-slot="empty-description"
      className={cn(
        "text-sm/relaxed text-muted-foreground [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary",
        className
      )}
      {...props}
    />
  )
}

function EmptyContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-content"
      className={cn(
        "flex w-full max-w-sm min-w-0 flex-col items-center gap-2.5 text-sm text-balance",
        className
      )}
      {...props}
    />
  )
}

export {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
  EmptyMedia,
}
