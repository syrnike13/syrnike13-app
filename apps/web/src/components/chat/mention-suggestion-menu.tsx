import { useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { SuggestionProps } from '@tiptap/suggestion'
import { UsersIcon, WifiIcon } from '#/components/icons'

import { UserAvatar } from '#/components/user/user-avatar'
import type { MentionSuggestionItem } from '#/lib/message-format/extensions/mention-suggestion'
import { cn } from '#/lib/utils'

export type MentionSuggestionState = SuggestionProps<MentionSuggestionItem> & {
  selectedIndex: number
  onHighlightIndex?: (index: number) => void
}

type MentionSuggestionMenuProps = {
  suggestion: MentionSuggestionState
  anchorRef: RefObject<HTMLElement | null>
  surfaceClassName?: string
}

function MassMentionIcon({ kind }: { kind: 'everyone' | 'online' }) {
  const Icon = kind === 'online' ? WifiIcon : UsersIcon
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
      <Icon className="size-4" />
    </span>
  )
}

function RoleMentionIcon({ colour }: { colour?: string }) {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
      <span
        className="size-3.5 rounded-full border border-border"
        style={colour ? { backgroundColor: colour } : undefined}
      />
    </span>
  )
}

function MentionSuggestionRow({
  item,
  selected,
  onSelect,
  onHighlight,
  buttonRef,
}: {
  item: MentionSuggestionItem
  selected: boolean
  onSelect: () => void
  onHighlight: () => void
  buttonRef?: React.Ref<HTMLButtonElement>
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={cn(
        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors',
        selected
          ? 'bg-accent text-accent-foreground'
          : 'hover:bg-accent/70',
      )}
      onMouseEnter={onHighlight}
      onMouseDown={(event) => {
        event.preventDefault()
        onSelect()
      }}
    >
      {item.kind === 'user' ? (
        <UserAvatar
          user={item.user}
          className="size-8"
          showPresence={false}
        />
      ) : item.kind === 'role' ? (
        <RoleMentionIcon colour={item.colour} />
      ) : (
        <MassMentionIcon kind={item.kind} />
      )}

      <span className="min-w-0 flex-1">
        {item.kind === 'user' ? (
          <>
            <span
              className="block truncate text-sm font-medium leading-tight"
              style={item.nameColour ? { color: item.nameColour } : undefined}
            >
              {item.serverName}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              @{item.username}
            </span>
          </>
        ) : item.kind === 'role' ? (
          <>
            <span
              className="block truncate text-sm font-medium leading-tight"
              style={item.colour ? { color: item.colour } : undefined}
            >
              {item.label}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {item.description}
            </span>
          </>
        ) : (
          <>
            <span className="block truncate text-sm font-medium text-primary leading-tight">
              {item.label}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {item.description}
            </span>
          </>
        )}
      </span>
    </button>
  )
}

export function MentionSuggestionMenu({
  suggestion,
  anchorRef,
  surfaceClassName = 'bg-popover text-popover-foreground',
}: MentionSuggestionMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const selectedItemRef = useRef<HTMLButtonElement>(null)
  const [coords, setCoords] = useState<{
    left: number
    width: number
    top: number
  } | null>(null)

  useEffect(() => {
    const updatePosition = () => {
      const anchor = anchorRef.current
      if (!anchor) return

      const rect = anchor.getBoundingClientRect()
      const gap = 14

      setCoords({
        left: rect.left,
        width: rect.width,
        top: rect.top - gap,
      })
    }

    updatePosition()
    const raf = requestAnimationFrame(updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    window.addEventListener('resize', updatePosition)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', updatePosition, true)
      window.removeEventListener('resize', updatePosition)
    }
  }, [anchorRef, suggestion])

  useEffect(() => {
    selectedItemRef.current?.scrollIntoView({ block: 'nearest' })
  }, [suggestion.selectedIndex, suggestion.items])

  if (!coords || suggestion.items.length === 0) return null

  return createPortal(
    <div
      ref={menuRef}
      className={cn(
        'pointer-events-auto fixed z-[300] flex max-h-72 flex-col gap-0.5 overflow-y-auto rounded-lg border border-shell-divider p-1 shadow-lg ring-1 ring-shell-divider',
        surfaceClassName,
      )}
      style={{
        left: coords.left,
        width: coords.width,
        top: coords.top,
        transform: 'translateY(-100%)',
      }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {suggestion.items.map((item, index) => (
        <MentionSuggestionRow
          key={
            item.kind === 'user' || item.kind === 'role'
              ? `${item.kind}-${item.id}`
              : item.kind
          }
          item={item}
          selected={index === suggestion.selectedIndex}
          buttonRef={
            index === suggestion.selectedIndex ? selectedItemRef : undefined
          }
          onHighlight={() => suggestion.onHighlightIndex?.(index)}
          onSelect={() => suggestion.command(item)}
        />
      ))}
    </div>,
    document.body,
  )
}
