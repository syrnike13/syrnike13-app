import { useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { SuggestionProps } from '@tiptap/suggestion'

import { UserAvatar } from '#/components/user/user-avatar'
import type { MentionSuggestionItem } from '#/lib/message-format/extensions/mention-suggestion'
import { cn } from '#/lib/utils'

export type MentionSuggestionState = SuggestionProps<MentionSuggestionItem> & {
  selectedIndex: number
  onHighlightIndex?: (index: number) => void
}

type MentionSuggestionMenuProps = {
  id: string
  suggestion: MentionSuggestionState
  anchorRef: RefObject<HTMLElement | null>
  surfaceClassName?: string
}

function MentionSuggestionRow({
  item,
  selected,
  onSelect,
  onHighlight,
  buttonRef,
  id,
}: {
  item: MentionSuggestionItem
  selected: boolean
  onSelect: () => void
  onHighlight: () => void
  buttonRef?: React.Ref<HTMLButtonElement>
  id: string
}) {
  return (
    <button
      ref={buttonRef}
      id={id}
      type="button"
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      className={cn(
        'flex h-10 w-full items-center gap-3 rounded-md px-3 text-left transition-colors',
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
          showPresence
          presenceRingClassName="border-popover"
        />
      ) : null}

      <span
        className={cn(
          'min-w-0 flex-1 truncate text-sm font-medium leading-none',
          item.kind !== 'user' && item.kind !== 'role' && 'text-foreground',
        )}
        style={
          item.kind === 'user'
            ? item.nameColour
              ? { color: item.nameColour }
              : undefined
            : item.kind === 'role' && item.colour
              ? { color: item.colour }
              : undefined
        }
      >
        {item.kind === 'user' ? item.serverName : item.label}
      </span>

      <span className="ml-4 max-w-[55%] shrink-0 truncate text-right text-xs text-muted-foreground">
        {item.kind === 'user' ? `@${item.username}` : item.description}
      </span>
    </button>
  )
}

export function MentionSuggestionMenu({
  id,
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

  const participantEntries: Array<{
    item: MentionSuggestionItem
    index: number
  }> = []
  const otherEntries: Array<{
    item: MentionSuggestionItem
    index: number
  }> = []

  for (const [index, item] of suggestion.items.entries()) {
    const entry = { item, index }
    if (item.kind === 'user') participantEntries.push(entry)
    else otherEntries.push(entry)
  }

  const renderEntry = ({
    item,
    index,
  }: {
    item: MentionSuggestionItem
    index: number
  }) => (
    <MentionSuggestionRow
      key={'id' in item ? `${item.kind}:${item.id}` : item.kind}
      item={item}
      id={`${id}-option-${index}`}
      selected={index === suggestion.selectedIndex}
      buttonRef={
        index === suggestion.selectedIndex ? selectedItemRef : undefined
      }
      onHighlight={() => suggestion.onHighlightIndex?.(index)}
      onSelect={() => suggestion.command(item)}
    />
  )

  return createPortal(
    <div
      ref={menuRef}
      id={id}
      role="listbox"
      aria-label="Упоминания"
      className={cn(
        'gradient-surface-solid pointer-events-auto fixed z-[300] flex flex-col overflow-hidden rounded-lg border border-border/20 p-1 shadow-lg',
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
      {participantEntries.length > 0 ? (
        <div role="group" aria-label="Участники">
          <div
            role="presentation"
            className="px-3 py-1.5 text-xs font-medium text-muted-foreground"
          >
            Участники
          </div>
          {participantEntries.map(renderEntry)}
        </div>
      ) : null}

      {otherEntries.length > 0 ? (
        <div
          role="group"
          aria-label="Другие упоминания"
          className={cn(
            participantEntries.length > 0 &&
              'mt-1 border-t border-border/20 pt-1',
          )}
        >
          {otherEntries.map(renderEntry)}
        </div>
      ) : null}
    </div>,
    document.body,
  )
}
