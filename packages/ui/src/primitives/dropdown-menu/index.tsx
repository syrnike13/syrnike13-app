"use client"

import * as React from "react"
import { Menu as MenuPrimitive } from "@base-ui/react/menu"
import { cn } from "../../lib/cn"

import { usePortalContainer } from "../portal-container"

import { IconPlaceholder } from "../icon-placeholder"

function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuPortal({ ...props }: MenuPrimitive.Portal.Props) {
  const portalContainer = usePortalContainer()

  return (
    <MenuPrimitive.Portal
      data-slot="dropdown-menu-portal"
      container={portalContainer ?? undefined}
      {...props}
    />
  )
}

function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
}

function DropdownMenuContent({
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  className,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<
    MenuPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  const portalContainer = usePortalContainer()

  return (
    <MenuPrimitive.Portal container={portalContainer ?? undefined}>
      <MenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            "cn-menu-target cn-menu-translucent z-50 max-h-(--available-height) min-w-32 overflow-x-hidden overflow-y-auto rounded-lg bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none data-closed:overflow-hidden",
            className
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

function DropdownMenuGroup({ ...props }: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: MenuPrimitive.GroupLabel.Props & {
  inset?: boolean
}) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
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
function DropdownMenuItemContent({
  children,
  description,
}: {
  children: React.ReactNode
  description: React.ReactNode
}) {
  return (
    <span
      data-slot="dropdown-menu-item-content"
      className="flex min-w-0 flex-1 flex-col"
    >
      <span className="flex min-w-0 items-center gap-1.5 [&_svg]:opacity-70">
        {children}
      </span>
      <span
        data-slot="dropdown-menu-item-description"
        className="mt-0.5 block min-w-0 truncate text-xs font-normal text-muted-foreground"
      >
        {description}
      </span>
    </span>
  )
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  description,
  children,
  ...props
}: MenuPrimitive.Item.Props & {
  inset?: boolean
  variant?: "default" | "destructive"
  /** Вторая строка под подписью пункта. */
  description?: React.ReactNode
}) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "group/dropdown-menu-item relative flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-2 text-sm font-bold outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-inset:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&>svg]:opacity-70 focus:[&>svg]:opacity-100 data-highlighted:[&>svg]:opacity-100 focus:[&_[data-slot$='-item-content']_svg]:opacity-100 data-highlighted:[&_[data-slot$='-item-content']_svg]:opacity-100 focus:[&_[data-slot$='-item-description']]:text-muted-foreground data-highlighted:[&_[data-slot$='-item-description']]:text-muted-foreground [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[variant=destructive]:*:[svg]:text-destructive",
        description != null && "py-1.5",
        className
      )}
      {...props}
    >
      {description != null ? (
        <DropdownMenuItemContent description={description}>
          {children}
        </DropdownMenuItemContent>
      ) : (
        children
      )}
    </MenuPrimitive.Item>
  )
}

function DropdownMenuSub({ ...props }: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />
}

function DropdownMenuSubTrigger({
  className,
  inset,
  description,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean
  /** Вторая строка под подписью пункта. */
  description?: React.ReactNode
}) {
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-2 text-sm font-bold outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-inset:pl-7 data-popup-open:bg-accent data-popup-open:text-accent-foreground data-open:bg-accent data-open:text-accent-foreground [&_svg]:pointer-events-none [&>svg]:opacity-70 focus:[&>svg]:opacity-100 data-highlighted:[&>svg]:opacity-100 focus:[&_[data-slot$='-item-content']_svg]:opacity-100 data-highlighted:[&_[data-slot$='-item-content']_svg]:opacity-100 focus:[&_[data-slot$='-item-description']]:text-muted-foreground data-highlighted:[&_[data-slot$='-item-description']]:text-muted-foreground [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        description != null && "py-1.5",
        className
      )}
      {...props}
    >
      {description != null ? (
        <DropdownMenuItemContent description={description}>
          {children}
        </DropdownMenuItemContent>
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
    </MenuPrimitive.SubmenuTrigger>
  )
}

function DropdownMenuSubContent({
  align = "start",
  alignOffset = -3,
  side = "right",
  sideOffset = 0,
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuContent>) {
  return (
    <DropdownMenuContent
      data-slot="dropdown-menu-sub-content"
      className={cn(
        "cn-menu-target cn-menu-translucent w-auto min-w-[96px] rounded-lg bg-popover p-2 text-popover-foreground shadow-lg ring-1 ring-foreground/10",
        className
      )}
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      {...props}
    />
  )
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  description,
  ...props
}: MenuPrimitive.CheckboxItem.Props & {
  inset?: boolean
  /** Вторая строка под подписью пункта. */
  description?: React.ReactNode
}) {
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      data-inset={inset}
      className={cn(
        "group/checkbox-item relative flex cursor-default items-center gap-1.5 rounded-md py-2 pr-9 pl-1.5 text-sm font-bold outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&>svg]:opacity-70 focus:[&>svg]:opacity-100 data-highlighted:[&>svg]:opacity-100 focus:[&_[data-slot$='-item-content']_svg]:opacity-100 data-highlighted:[&_[data-slot$='-item-content']_svg]:opacity-100 focus:[&_[data-slot$='-item-description']]:text-muted-foreground data-highlighted:[&_[data-slot$='-item-description']]:text-muted-foreground [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        description != null && "py-1.5",
        className
      )}
      checked={checked}
      {...props}
    >
      {/* Not in base-nova: a visible checkbox box, empty when unchecked. */}
      <span
        className="pointer-events-none absolute right-2 flex size-4.5 items-center justify-center rounded-sm border border-input group-data-checked/checkbox-item:border-primary group-data-checked/checkbox-item:bg-primary [&_svg]:size-3.5 **:text-primary-foreground! [&_svg]:opacity-100!"
        data-slot="dropdown-menu-checkbox-item-indicator"
      >
        <MenuPrimitive.CheckboxItemIndicator>
          <IconPlaceholder
            lucide="CheckIcon"
            tabler="IconCheck"
            hugeicons="Tick02Icon"
            phosphor="CheckIcon"
            remixicon="RiCheckLine"
          />
        </MenuPrimitive.CheckboxItemIndicator>
      </span>
      {description != null ? (
        <DropdownMenuItemContent description={description}>
          {children}
        </DropdownMenuItemContent>
      ) : (
        children
      )}
    </MenuPrimitive.CheckboxItem>
  )
}

function DropdownMenuRadioGroup({ ...props }: MenuPrimitive.RadioGroup.Props) {
  return (
    <MenuPrimitive.RadioGroup
      data-slot="dropdown-menu-radio-group"
      {...props}
    />
  )
}

function DropdownMenuRadioItem({
  className,
  children,
  inset,
  description,
  ...props
}: MenuPrimitive.RadioItem.Props & {
  inset?: boolean
  /** Вторая строка под подписью пункта. */
  description?: React.ReactNode
}) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      data-inset={inset}
      className={cn(
        "relative flex cursor-default items-center gap-1.5 rounded-md py-2 pr-8 pl-1.5 text-sm font-bold outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&>svg]:opacity-70 focus:[&>svg]:opacity-100 data-highlighted:[&>svg]:opacity-100 focus:[&_[data-slot$='-item-content']_svg]:opacity-100 data-highlighted:[&_[data-slot$='-item-content']_svg]:opacity-100 focus:[&_[data-slot$='-item-description']]:text-muted-foreground data-highlighted:[&_[data-slot$='-item-description']]:text-muted-foreground [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        description != null && "py-1.5",
        className
      )}
      {...props}
    >
      <span
        className="pointer-events-none absolute right-2 flex items-center justify-center"
        data-slot="dropdown-menu-radio-item-indicator"
      >
        <MenuPrimitive.RadioItemIndicator>
          <IconPlaceholder
            lucide="CheckIcon"
            tabler="IconCheck"
            hugeicons="Tick02Icon"
            phosphor="CheckIcon"
            remixicon="RiCheckLine"
          />
        </MenuPrimitive.RadioItemIndicator>
      </span>
      {description != null ? (
        <DropdownMenuItemContent description={description}>
          {children}
        </DropdownMenuItemContent>
      ) : (
        children
      )}
    </MenuPrimitive.RadioItem>
  )
}

function DropdownMenuSeparator({
  className,
  ...props
}: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-2 my-2 h-px bg-border", className)}
      {...props}
    />
  )
}

function DropdownMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground group-focus/dropdown-menu-item:text-accent-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
}
