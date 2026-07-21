import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { usePortalContainer } from "#/components/ui/portal-container"
import { cn } from "#/lib/utils.ts"

/** Tooltips must render above dialogs, popovers, and other overlays. */
const tooltipLayerClass = "z-[9999]"

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

/**
 * Radix opens tooltips on ANY focus event: mouse click, programmatic focus
 * (e.g. dialog auto-focus on open/close), and window refocus after
 * minimize/Alt-Tab. Only keyboard focus (`:focus-visible`) should open the
 * tooltip. Radix skips its internal focus handler when the event is
 * default-prevented (composeEventHandlers), so we preventDefault here.
 */
function suppressNonKeyboardFocus(event: React.FocusEvent<HTMLElement>) {
  const target = event.target
  if (!(target instanceof HTMLElement)) {
    event.preventDefault()
    return
  }
  try {
    if (!target.matches(":focus-visible")) {
      event.preventDefault()
    }
  } catch {
    // Environments without :focus-visible support (older jsdom) keep the
    // previous behavior and allow focus-opened tooltips.
  }
}

function TooltipTrigger({
  onFocus,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      {...props}
      onFocus={(event) => {
        onFocus?.(event)
        if (!event.defaultPrevented) {
          suppressNonKeyboardFocus(event)
        }
      }}
    />
  )
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  const portalContainer = usePortalContainer()

  return (
    <TooltipPrimitive.Portal container={portalContainer ?? undefined}>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "gradient-surface-solid w-fit origin-(--radix-tooltip-content-transform-origin) animate-in rounded-md border border-border bg-popover px-3 py-1.5 text-xs text-balance text-popover-foreground shadow-md fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className,
          tooltipLayerClass,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
