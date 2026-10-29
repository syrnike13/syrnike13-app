"use client"

import * as React from "react"
import { Avatar as AvatarPrimitive } from "@base-ui/react/avatar"
import { cn } from "../../lib/cn"

function Avatar({
  className,
  size = "default",
  badgeCutout = false,
  ...props
}: AvatarPrimitive.Root.Props & {
  /** `xs` (not in base-nova): 16px, inline with text (mutual friends). */
  size?: "default" | "xs" | "sm" | "lg"
  /** Not in base-nova: cut the avatar out around a sibling `AvatarBadge`. */
  badgeCutout?: boolean
}) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      data-size={size}
      data-badge-cutout={badgeCutout ? "" : undefined}
      className={cn(
        "group/avatar relative flex size-8 shrink-0 rounded-full select-none after:absolute after:inset-0 after:rounded-full after:border after:border-border after:mix-blend-darken data-[size=lg]:size-10 data-[size=sm]:size-6 data-[size=xs]:size-4 dark:after:mix-blend-lighten data-badge-cutout:avatar-badge-cutout",
        className
      )}
      {...props}
    />
  )
}

function AvatarImage({ className, ...props }: AvatarPrimitive.Image.Props) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn(
        "aspect-square size-full rounded-full object-cover",
        className
      )}
      {...props}
    />
  )
}

function AvatarFallback({
  className,
  ...props
}: AvatarPrimitive.Fallback.Props) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        "flex size-full items-center justify-center rounded-full bg-muted text-sm text-muted-foreground group-data-[size=sm]/avatar:text-xs group-data-[size=xs]/avatar:text-3xs",
        className
      )}
      {...props}
    />
  )
}

export type AvatarPresence = "online" | "idle" | "focus" | "dnd" | "offline"

function AvatarBadge({
  className,
  presence,
  count,
  children,
  ...props
}: React.ComponentProps<"span"> & {
  /** Not in base-nova: a Discord-like status dot (see `avatar-badge-anchor`). */
  presence?: AvatarPresence
  /** Not in base-nova: an unread count pill in the same corner. */
  count?: string
}) {
  const anchored = presence != null || count != null
  return (
    <span
      data-slot="avatar-badge"
      data-presence={presence}
      data-count={count != null ? "" : undefined}
      className={cn(
        "absolute right-0 bottom-0 z-10 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground bg-blend-color ring-2 ring-background select-none",
        "group-data-[size=sm]/avatar:size-2 group-data-[size=sm]/avatar:[&>svg]:hidden",
        "group-data-[size=default]/avatar:size-2.5 group-data-[size=default]/avatar:[&>svg]:size-2",
        "group-data-[size=lg]/avatar:size-3 group-data-[size=lg]/avatar:[&>svg]:size-2",
        anchored &&
          "data-presence:avatar-badge-anchor data-count:avatar-badge-anchor data-presence:ring-0 data-count:ring-0",
        presence &&
          "data-presence:avatar-presence-dot data-[presence=dnd]:bg-destructive data-[presence=focus]:bg-agent data-[presence=idle]:bg-warning data-[presence=offline]:bg-muted-foreground data-[presence=online]:bg-success",
        count != null &&
          "bg-destructive-contrast leading-none font-bold text-destructive-foreground tabular-nums",
        className
      )}
      {...props}
    >
      {count ?? children}
    </span>
  )
}

function AvatarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-group"
      className={cn(
        "group/avatar-group flex -space-x-2 *:data-[slot=avatar]:ring-2 *:data-[slot=avatar]:ring-background",
        className
      )}
      {...props}
    />
  )
}

function AvatarGroupCount({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-group-count"
      className={cn(
        "relative flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm text-muted-foreground ring-2 ring-background group-has-data-[size=lg]/avatar-group:size-10 group-has-data-[size=sm]/avatar-group:size-6 [&>svg]:size-4 group-has-data-[size=lg]/avatar-group:[&>svg]:size-5 group-has-data-[size=sm]/avatar-group:[&>svg]:size-3",
        className
      )}
      {...props}
    />
  )
}

export {
  Avatar,
  AvatarImage,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarBadge,
}
