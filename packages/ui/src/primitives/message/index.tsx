import * as React from "react"
import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../../lib/cn"

/**
 * Discord-style chat feed (cozy layout). Not the base-nova bubble message:
 * rows are full-width, the 72px left gutter holds the avatar (group start) or
 * the hover timestamp (group continuation), and every chat surface — reply
 * quote, hover toolbar, reactions, dividers — lives here so call sites only
 * compose slots.
 */

function MessageGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-group"
      className={cn("flex min-w-0 flex-col", className)}
      {...props}
    />
  )
}

/**
 * One feed row: 2px 48px 2px 72px. `groupStart` adds the 17px group gap and
 * room for the avatar. `highlighted` (reply target, jump) and `mentioned`
 * tint the row and draw a 2px bar on the left edge.
 */
function Message({
  className,
  groupStart = false,
  highlighted = false,
  mentioned = false,
  ...props
}: React.ComponentProps<"div"> & {
  groupStart?: boolean
  highlighted?: boolean
  mentioned?: boolean
}) {
  return (
    <div
      data-slot="message"
      data-group-start={groupStart || undefined}
      data-highlighted={highlighted || undefined}
      data-mentioned={mentioned || undefined}
      className={cn(
        "group/message relative flex w-full min-w-0 py-0.5 pr-12 pl-18 transition-colors duration-500 before:absolute before:inset-y-0 before:left-0 before:w-0.5 hover:bg-hover data-group-start:mt-4.25 data-group-start:has-data-[slot=message-avatar]:min-h-11 data-mentioned:bg-warning/10 data-mentioned:before:bg-warning data-highlighted:bg-primary/10 data-highlighted:before:bg-primary",
        className
      )}
      {...props}
    />
  )
}

/** 40px avatar in the gutter; drops below the reply quote when there is one. */
function MessageAvatar({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-avatar"
      className={cn(
        "absolute top-0.5 left-4 size-10 shrink-0 overflow-hidden rounded-full group-has-data-[slot=message-reply]/message:top-6",
        className
      )}
      {...props}
    />
  )
}

const messageIconVariants = cva(
  "absolute top-0.5 left-4 flex h-5.5 w-10 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      tone: {
        default: "text-muted-foreground",
        success: "text-success",
        destructive: "text-destructive",
      },
    },
    defaultVariants: {
      tone: "default",
    },
  }
)

/** System row icon in the gutter, centered on the first text line. */
function MessageIcon({
  className,
  tone = "default",
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof messageIconVariants>) {
  return (
    <span
      aria-hidden
      data-slot="message-icon"
      className={cn(messageIconVariants({ tone }), className)}
      {...props}
    />
  )
}

function MessageContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-content"
      className={cn(
        "flex min-w-0 flex-1 flex-col text-base leading-5.5 wrap-break-word text-foreground",
        className
      )}
      {...props}
    />
  )
}

/** Author line: name 16/22 w500, then timestamp and badges 4px apart. */
function MessageHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-header"
      className={cn(
        "flex min-h-5.5 max-w-full min-w-0 items-baseline gap-1 text-base leading-5.5 font-medium text-foreground",
        className
      )}
      {...props}
    />
  )
}

const messageTimestampVariants = cva(
  "shrink-0 text-xs leading-5.5 font-medium text-muted-foreground",
  {
    variants: {
      placement: {
        header: "ml-1",
        // Group continuation: the time sits in the gutter and shows on hover.
        gutter:
          "pointer-events-none absolute top-0.5 left-0 w-18 text-center text-3xs opacity-0 group-hover/message:opacity-100",
      },
    },
    defaultVariants: {
      placement: "header",
    },
  }
)

function MessageTimestamp({
  className,
  placement = "header",
  ...props
}: React.ComponentProps<"time"> &
  VariantProps<typeof messageTimestampVariants>) {
  return (
    <time
      data-slot="message-timestamp"
      data-placement={placement}
      className={cn(messageTimestampVariants({ placement }), className)}
      {...props}
    />
  )
}

/** Muted inline note after the text, e.g. "(edited)". */
function MessageNote({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="message-note"
      className={cn("ml-1 text-3xs leading-none text-muted-foreground", className)}
      {...props}
    />
  )
}

/**
 * Reply quote above the author line (14/18). Draws the spine from the avatar
 * center to the quote. Renders a div by default; pass a button through
 * `render` to make it jump to the original.
 */
function MessageReply({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn(
          "relative mb-1 flex h-4.5 max-w-full min-w-0 items-center gap-1 rounded-sm text-left text-sm leading-4.5 text-muted-foreground outline-none before:absolute before:top-1/2 before:right-full before:-bottom-1 before:-left-9 before:mr-1 before:rounded-tl-md before:border-t-2 before:border-l-2 before:border-muted-foreground/40 focus-visible:ring-2 focus-visible:ring-ring [button]:cursor-pointer [button]:hover:text-foreground",
          className
        ),
      },
      props
    ),
    render,
    state: { slot: "message-reply" },
    stateAttributesMapping: { slot: (slot) => ({ "data-slot": slot }) },
  })
}

/**
 * Hover actions in the top-right corner. Shown while the row is hovered or
 * focused; pass `open` while one of its menus or pickers is open.
 */
function MessageToolbar({
  className,
  open = false,
  ...props
}: React.ComponentProps<"div"> & { open?: boolean }) {
  return (
    <div
      role="toolbar"
      data-slot="message-toolbar"
      data-open={open || undefined}
      className={cn(
        "absolute -top-4 right-3.5 z-10 hidden items-center gap-0.5 rounded-lg bg-popover p-0.5 text-popover-foreground shadow-md ring-1 ring-foreground/10 group-focus-within/message:flex group-hover/message:flex data-open:flex",
        className
      )}
      {...props}
    />
  )
}

function MessageReactions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-reactions"
      className={cn("mt-1 flex flex-wrap items-center gap-1", className)}
      {...props}
    />
  )
}

const messageReactionClass =
  "inline-flex h-6.5 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-transparent bg-secondary px-1.5 text-sm font-semibold text-muted-foreground tabular-nums transition-colors outline-none select-none hover:border-border focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"

/** Reaction chip: emoji plus count. Pressed means the current user reacted. */
function MessageReaction({ className, ...props }: TogglePrimitive.Props) {
  return (
    <TogglePrimitive
      data-slot="message-reaction"
      className={cn(
        messageReactionClass,
        "data-pressed:border-primary data-pressed:bg-primary/15 data-pressed:text-foreground",
        className
      )}
      {...props}
    />
  )
}

/** Trailing "add reaction" chip, visible while the row is hovered. */
function MessageReactionAdd({ className, ...props }: ButtonPrimitive.Props) {
  return (
    <ButtonPrimitive
      data-slot="message-reaction-add"
      className={cn(
        messageReactionClass,
        "w-8 opacity-0 group-focus-within/message:opacity-100 group-hover/message:opacity-100 hover:text-foreground data-popup-open:opacity-100",
        className
      )}
      {...props}
    />
  )
}

/**
 * Feed divider: `date` is a centered caption between two lines, `unread` is
 * the red "new messages" line with a tag on the right edge.
 */
const messageDividerVariants = cva(
  "flex items-center text-xs leading-4 font-semibold before:h-px before:flex-1",
  {
    variants: {
      variant: {
        date: "mt-6 mr-3.5 mb-2 ml-4 gap-1 text-muted-foreground before:bg-border after:h-px after:flex-1 after:bg-border",
        unread: "my-2 mr-3.5 ml-4 text-destructive-foreground before:bg-destructive",
      },
    },
    defaultVariants: {
      variant: "date",
    },
  }
)

const messageDividerLabelVariants = cva("px-1", {
  variants: {
    variant: {
      date: "",
      unread: "rounded-sm bg-destructive text-3xs uppercase",
    },
  },
  defaultVariants: {
    variant: "date",
  },
})

function MessageDivider({
  className,
  variant = "date",
  children,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof messageDividerVariants>) {
  return (
    <div
      role="separator"
      data-slot="message-divider"
      data-variant={variant}
      className={cn(messageDividerVariants({ variant }), className)}
      {...props}
    >
      <span className={messageDividerLabelVariants({ variant })}>{children}</span>
    </div>
  )
}

export {
  MessageGroup,
  Message,
  MessageAvatar,
  MessageContent,
  MessageDivider,
  MessageHeader,
  MessageIcon,
  MessageNote,
  MessageReaction,
  MessageReactionAdd,
  MessageReactions,
  MessageReply,
  MessageTimestamp,
  MessageToolbar,
}
