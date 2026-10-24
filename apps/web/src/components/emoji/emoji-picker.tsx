import type { ReactElement } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'

import { CustomEmoji } from '#/components/emoji/custom-emoji'
import { Button } from '@syrnike13/ui/primitives/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@syrnike13/ui/primitives/popover'
import { listServerCustomEmojis } from '#/features/sync/selectors'
import { useSyncStore } from '#/features/sync/sync-store'
import { QUICK_REACTIONS } from '#/lib/reactions'

type EmojiPickerProps = {
  trigger: ReactElement
  /** Unicode emoji or a custom emoji id. */
  onPick: (emoji: string) => void
  serverId?: string | null
  open?: boolean
  onOpenChange?: (open: boolean) => void
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'bottom' | 'left' | 'right'
}

/** One picker for the composer and reactions: quick emoji plus server emoji. */
export function EmojiPicker({
  trigger,
  onPick,
  serverId,
  open,
  onOpenChange,
  align = 'end',
  side = 'top',
}: EmojiPickerProps) {
  const t = useTranslations('chat')
  const customEmojis = useSyncStore((s) =>
    serverId ? listServerCustomEmojis(s, serverId) : [],
  )

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={trigger} />
      <PopoverContent className="w-80" align={align} side={side}>
        <section className="flex flex-col gap-1">
          <h3 className="px-1 text-xs font-medium text-muted-foreground">
            {t('emoji')}
          </h3>
          <div className="grid grid-cols-8 gap-0.5">
            {QUICK_REACTIONS.map((emoji) => (
              <Button
                key={emoji}
                type="button"
                variant="ghost"
                size="icon"
                aria-label={emoji}
                onClick={() => onPick(emoji)}
              >
                <span className="text-xl leading-none">{emoji}</span>
              </Button>
            ))}
          </div>
        </section>
        {customEmojis.length > 0 ? (
          <section className="flex flex-col gap-1">
            <h3 className="px-1 text-xs font-medium text-muted-foreground">
              {t('serverEmojis')}
            </h3>
            <div className="grid max-h-40 grid-cols-8 gap-0.5 overflow-y-auto">
              {customEmojis.map((emoji) => (
                <Button
                  key={emoji._id}
                  type="button"
                  variant="ghost"
                  size="icon"
                  title={`:${emoji.name}:`}
                  aria-label={`:${emoji.name}:`}
                  onClick={() => onPick(emoji._id)}
                >
                  <CustomEmoji emojiId={emoji._id} name={emoji.name} size="sm" />
                </Button>
              ))}
            </div>
          </section>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
