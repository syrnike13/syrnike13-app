"use client"

import * as React from "react"
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu"
import { cn } from "../../lib/cn"

import { usePortalContainer } from "../portal-container"

import { IconPlaceholder } from "../icon-placeholder"

function ContextMenu({ ...props }: ContextMenuPrimitive.Root.Props) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />
}

function ContextMenuPortal({ ...props }: ContextMenuPrimitive.Portal.Props) {
  const portalContainer = usePortalContainer()

  return (
    <ContextMenuPrimitive.Portal
      data-slot="context-menu-portal"
      container={portalContainer ?? undefined}
      {...props}
    />
  )
}

function ContextMenuTrigger({
  className,
  ...props
}: ContextMenuPrimitive.Trigger.Props) {
  return (
    <ContextMenuPrimitive.Trigger
      data-slot="context-menu-trigger"
      className={cn("select-none", className)}
      {...props}
    />
  )
}

function ContextMenuContent({
  className,
  align = "start",
  alignOffset = 4,
  side = "right",
  sideOffset = 0,
  ...props
}: ContextMenuPrimitive.Popup.Props &
  Pick<
    ContextMenuPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  const portalContainer = usePortalContainer()

  return (
    <ContextMenuPrimitive.Portal container={portalContainer ?? undefined}>
      <ContextMenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn(
            "cn-menu-target cn-menu-translucent z-50 max-h-(--available-height) min-w-36 overflow-x-hidden overflow-y-auto rounded-lg bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none",
            className
          )}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuGroup({ ...props }: ContextMenuPrimitive.Group.Props) {
  return (
    <ContextMenuPrimitive.Group data-slot="context-menu-group" {...props} />
  )
}

function ContextMenuLabel({
  className,
  inset,
  ...props
}: ContextMenuPrimitive.GroupLabel.Props & {
  inset?: boolean
}) {
  return (
    <ContextMenuPrimitive.GroupLabel
      data-slot="context-menu-label"
      data-inset={inset}
      className={cn(
        "px-1.5 py-1 text-xs font-medium text-muted-foreground data-inset:pl-7",
        className
      )}
      {...props}
    />
  )
}

/**
 * Item content with a secondary line. The base-nova source has no description
 * slot, so this is a deliberate extension. Icons stay in the title row and the
 * item-level focus rules brighten them through `data-slot$="-item-content"`.
 */
function ContextMenuItemContent({
  children,
  description,
}: {
  children: React.ReactNode
  description: React.ReactNode
}) {
  return (
    <span
      data-slot="context-menu-item-content"
      className="flex min-w-0 flex-1 flex-col"
    >
      <span className="flex min-w-0 items-center gap-1.5 [&_svg]:opacity-70">
        {children}
      </span>
      <span
        data-slot="context-menu-item-description"
        className="mt-0.5 block min-w-0 truncate text-xs font-normal text-muted-foreground"
      >
        {description}
      </span>
    </span>
  )
}

function ContextMenuItem({
  className,
  inset,
  variant = "default",
  description,
  children,
  ...props
}: ContextMenuPrimitive.Item.Props & {
  inset?: boolean
  variant?: "default" | "destructive"
  /** Вторая строка под подписью пункта. */
  description?: React.ReactNode
}) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "group/context-menu-item relative flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-2 text-sm font-bold outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-inset:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&>svg]:opacity-70 focus:[&>svg]:opacity-100 data-highlighted:[&>svg]:opacity-100 focus:[&_[data-slot$='-item-content']_svg]:opacity-100 data-highlighted:[&_[data-slot$='-item-content']_svg]:opacity-100 focus:[&_[data-slot$='-item-description']]:text-muted-foreground data-highlighted:[&_[data-slot$='-item-description']]:text-muted-foreground [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 focus:*:[svg]:text-accent-foreground data-[variant=destructive]:*:[svg]:text-destructive",
        description != null && "py-1.5",
        className
      )}
      {...props}
    >
      {description != null ? (
        <ContextMenuItemContent description={description}>
          {children}
        </ContextMenuItemContent>
      ) : (
        children
      )}
    </ContextMenuPrimitive.Item>
  )
}

function ContextMenuSub({ ...props }: ContextMenuPrimitive.SubmenuRoot.Props) {
  return (
    <ContextMenuPrimitive.SubmenuRoot data-slot="context-menu-sub" {...props} />
  )
}

function ContextMenuSubTrigger({
  className,
  inset,
  description,
  children,
  ...props
}: ContextMenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean
  /** Вторая строка под подписью пункта. */
  description?: React.ReactNode
}) {
  return (
    <ContextMenuPrimitive.SubmenuTrigger
      data-slot="context-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-2 text-sm font-bold outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-inset:pl-7 data-open:bg-accent data-open:text-accent-foreground [&_svg]:pointer-events-none [&>svg]:opacity-70 focus:[&>svg]:opacity-100 data-highlighted:[&>svg]:opacity-100 focus:[&_[data-slot$='-item-content']_svg]:opacity-100 data-highlighted:[&_[data-slot$='-item-content']_svg]:opacity-100 focus:[&_[data-slot$='-item-description']]:text-muted-foreground data-highlighted:[&_[data-slot$='-item-description']]:text-muted-foreground [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        description != null && "py-1.5",
        className
      )}
      {...props}
    >
      {description != null ? (
        <ContextMenuItemContent description={description}>
          {children}
        </ContextMenuItemContent>
      ) : (
        children
      )}
      <IconPlaceholder
        lucide="ChevronRightIcon"
        tabler="IconChevronRight"
        hugeicons="ArrowRight01Icon"
        phosphor="CaretRightIcon"
        remixicon="RiArrowRightSLine"
        className="cn-rtl-flip ml-auto"
      />
    </ContextMenuPrimitive.SubmenuTrigger>
  )
}

function ContextMenuSubContent({
  ...props
}: React.ComponentProps<typeof ContextMenuContent>) {
  return (
    <ContextMenuContent
      data-slot="context-menu-sub-content"
      className="cn-menu-target cn-menu-translucent shadow-lg"
      side="right"
      {...props}
    />
  )
}

function ContextMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  description,
  ...props
}: ContextMenuPrimitive.CheckboxItem.Props & {
  inset?: boolean
  /** Вторая строка под подписью пункта. */
  description?: React.ReactNode
}) {
  return (
    <ContextMenuPrimitive.CheckboxItem
      data-slot="context-menu-checkbox-item"
      data-inset={inset}
      className={cn(
        "group/checkbox-item relative flex cursor-default items-center gap-1.5 rounded-md py-2 pr-9 pl-1.5 text-sm font-bold outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&>svg]:opacity-70 focus:[&>svg]:opacity-100 data-highlighted:[&>svg]:opacity-100 focus:[&_[data-slot$='-item-content']_svg]:opacity-100 data-highlighted:[&_[data-slot$='-item-content']_svg]:opacity-100 focus:[&_[data-slot$='-item-description']]:text-muted-foreground data-highlighted:[&_[data-slot$='-item-description']]:text-muted-foreground [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        description != null && "py-1.5",
        className
      )}
      checked={checked}
      {...props}
    >
      {/* Not in base-nova: a visible checkbox box, empty when unchecked. */}
      <span className="pointer-events-none absolute right-2 flex size-4.5 items-center justify-center rounded-sm border border-input group-data-checked/checkbox-item:border-primary group-data-checked/checkbox-item:bg-primary [&_svg]:size-3.5 **:text-primary-foreground! [&_svg]:opacity-100!">
        <ContextMenuPrimitive.CheckboxItemIndicator>
          <IconPlaceholder
            lucide="CheckIcon"
            tabler="IconCheck"
            hugeicons="Tick02Icon"
            phosphor="CheckIcon"
            remixicon="RiCheckLine"
          />
        </ContextMenuPrimitive.CheckboxItemIndicator>
      </span>
      {description != null ? (
        <ContextMenuItemContent description={description}>
          {children}
        </ContextMenuItemContent>
      ) : (
        children
      )}
    </ContextMenuPrimitive.CheckboxItem>
  )
}

function ContextMenuRadioGroup({
  ...props
}: ContextMenuPrimitive.RadioGroup.Props) {
  return (
    <ContextMenuPrimitive.RadioGroup
      data-slot="context-menu-radio-group"
      {...props}
    />
  )
}

function ContextMenuRadioItem({
  className,
  children,
  inset,
  description,
  ...props
}: ContextMenuPrimitive.RadioItem.Props & {
  inset?: boolean
  /** Вторая строка под подписью пункта. */
  description?: React.ReactNode
}) {
  return (
    <ContextMenuPrimitive.RadioItem
      data-slot="context-menu-radio-item"
      data-inset={inset}
      className={cn(
        "relative flex cursor-default items-center gap-1.5 rounded-md py-2 pr-8 pl-1.5 text-sm font-bold outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&>svg]:opacity-70 focus:[&>svg]:opacity-100 data-highlighted:[&>svg]:opacity-100 focus:[&_[data-slot$='-item-content']_svg]:opacity-100 data-highlighted:[&_[data-slot$='-item-content']_svg]:opacity-100 focus:[&_[data-slot$='-item-description']]:text-muted-foreground data-highlighted:[&_[data-slot$='-item-description']]:text-muted-foreground [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        description != null && "py-1.5",
        className
      )}
      {...props}
    >
      <span className="pointer-events-none absolute right-2">
        <ContextMenuPrimitive.RadioItemIndicator>
          <IconPlaceholder
            lucide="CheckIcon"
            tabler="IconCheck"
            hugeicons="Tick02Icon"
            phosphor="CheckIcon"
            remixicon="RiCheckLine"
          />
        </ContextMenuPrimitive.RadioItemIndicator>
      </span>
      {description != null ? (
        <ContextMenuItemContent description={description}>
          {children}
        </ContextMenuItemContent>
      ) : (
        children
      )}
    </ContextMenuPrimitive.RadioItem>
  )
}

function ContextMenuSeparator({
  className,
  ...props
}: ContextMenuPrimitive.Separator.Props) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn("-mx-2 my-2 h-px bg-border", className)}
      {...props}
    />
  )
}

function ContextMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="context-menu-shortcut"
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground group-focus/context-menu-item:text-accent-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuRadioItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuGroup,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuRadioGroup,
}
