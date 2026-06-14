import * as React from 'react'
import { Dialog as DialogPrimitive } from 'radix-ui'

import { cn } from '#/lib/utils'

function Drawer({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="drawer" {...props} />
}

function DrawerPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="drawer-portal" {...props} />
}

function DrawerOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="drawer-overlay"
      className={cn(
        'fixed inset-0 z-[300] bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0',
        className,
      )}
      {...props}
    />
  )
}

function DrawerContent({
  className,
  children,
  showHandle = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showHandle?: boolean
}) {
  return (
    <DrawerPortal>
      <DrawerOverlay />
      <DialogPrimitive.Content
        data-slot="drawer-content"
        className={cn(
          'fixed inset-x-0 bottom-0 z-[300] flex max-h-[min(90dvh,640px)] flex-col rounded-t-2xl border border-b-0 bg-background shadow-lg outline-none',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-bottom data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom',
          'pb-[env(safe-area-inset-bottom)] duration-300',
          className,
        )}
        {...props}
      >
        {showHandle ? (
          <div
            className="mx-auto mt-3 mb-2 h-1 w-10 shrink-0 rounded-full bg-muted"
            aria-hidden
          />
        ) : null}
        {children}
      </DialogPrimitive.Content>
    </DrawerPortal>
  )
}

function DrawerHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="drawer-header"
      className={cn('px-4 pb-2', className)}
      {...props}
    />
  )
}

function DrawerTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="drawer-title"
      className={cn('text-base font-semibold', className)}
      {...props}
    />
  )
}

function DrawerDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="drawer-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}

export {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerOverlay,
  DrawerPortal,
  DrawerTitle,
}
