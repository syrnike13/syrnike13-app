import * as React from "react"
import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../../lib/cn"

/**
 * Discord split control (mic, sound, voice stage controls). Not in base-nova:
 * a main icon segment and a narrow chevron segment joined into one pill.
 * Hovering either segment lights the whole group at half strength and the
 * hovered segment at full strength. Segments are Base UI buttons, so they can
 * be passed to tooltip and popover triggers through `render`.
 */
type SplitButtonContextValue = VariantProps<typeof splitButtonSegmentVariants>

const SplitButtonContext = React.createContext<SplitButtonContextValue>({})

const splitButtonSegmentVariants = cva(
  "inline-flex shrink-0 items-center justify-center text-muted-foreground transition-colors outline-none select-none first:rounded-l-lg last:rounded-r-lg focus-visible:z-10 focus-visible:ring-3 focus-visible:ring-ring/50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      segment: {
        main: "",
        chevron: "",
      },
      size: {
        default: "",
        lg: "",
      },
      variant: {
        default:
          "group-hover/split:bg-hover/50 group-hover/split:text-foreground hover:bg-hover",
        destructive:
          "bg-destructive/20 text-destructive group-hover/split:bg-destructive/25 hover:bg-destructive/30",
        success:
          "bg-success/20 text-success group-hover/split:bg-success/25 hover:bg-success/30",
      },
    },
    compoundVariants: [
      {
        segment: "main",
        size: "default",
        class: "size-8 [&_svg:not([class*='size-'])]:size-5",
      },
      {
        segment: "chevron",
        size: "default",
        class: "h-8 w-4 [&_svg:not([class*='size-'])]:size-3",
      },
      {
        segment: "main",
        size: "lg",
        class: "h-9 min-w-12 px-2 [&_svg:not([class*='size-'])]:size-5",
      },
      {
        segment: "chevron",
        size: "lg",
        class: "h-9 w-7 [&_svg:not([class*='size-'])]:size-3.5",
      },
    ],
    defaultVariants: {
      size: "default",
      variant: "default",
    },
  }
)

function SplitButton({
  className,
  size = "default",
  variant = "default",
  ...props
}: React.ComponentProps<"div"> &
  Omit<VariantProps<typeof splitButtonSegmentVariants>, "segment">) {
  return (
    <SplitButtonContext.Provider value={{ size, variant }}>
      <div
        role="group"
        data-slot="split-button"
        data-size={size}
        data-variant={variant}
        className={cn("group/split inline-flex items-stretch", className)}
        {...props}
      />
    </SplitButtonContext.Provider>
  )
}

function SplitButtonSegment({
  segment,
  className,
  ...props
}: ButtonPrimitive.Props & { segment: "main" | "chevron" }) {
  const { size, variant } = React.useContext(SplitButtonContext)
  return (
    <ButtonPrimitive
      data-slot={`split-button-${segment}`}
      className={cn(splitButtonSegmentVariants({ segment, size, variant }), className)}
      {...props}
    />
  )
}

function SplitButtonMain(props: ButtonPrimitive.Props) {
  return <SplitButtonSegment segment="main" {...props} />
}

function SplitButtonChevron(props: ButtonPrimitive.Props) {
  return <SplitButtonSegment segment="chevron" {...props} />
}

export { SplitButton, SplitButtonMain, SplitButtonChevron }
