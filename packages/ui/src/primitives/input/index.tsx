import * as React from "react"

import { cn } from "../../lib/cn"

type InputProps = React.ComponentProps<"input"> & {
  /** Borderless variant for inputs embedded in a shared surface (command palette, search rows). */
  variant?: "default" | "borderless"
}

function Input({ className, type, variant = "default", ...props }: InputProps) {
  return (
    <input
      type={type}
      data-slot="input"
      data-variant={variant}
      className={cn(
        "h-9 w-full min-w-0 rounded-md border px-3 py-1 text-base outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        variant === "default"
          ? "gradient-surface-input border-input bg-muted/40 shadow-xs transition-[color,box-shadow] dark:border-border dark:bg-secondary dark:text-secondary-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40"
          : "border-transparent bg-transparent focus-visible:border-transparent focus-visible:ring-0",
        className
      )}
      {...props}
    />
  )
}

export { Input }
