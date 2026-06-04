import { SmileIcon } from 'lucide-react'

import { CustomEmoji } from '#/components/emoji/custom-emoji'
import { Button } from '#/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { listServerCustomEmojis } from '#/features/sync/selectors'
import { useSyncStore } from '#/features/sync/sync-store'
import { QUICK_REACTIONS } from '#/lib/reactions'

type ComposerEmojiPickerProps = {
  serverId?: string | null
  disabled?: boolean
  onInsert: (text: string) => void
  triggerClassName?: string
}

export function ComposerEmojiPicker({
  serverId,
  disabled,
  onInsert,
  triggerClassName,
}: ComposerEmojiPickerProps) {
  const customEmojis = useSyncStore((s) =>
    serverId ? listServerCustomEmojis(s, serverId) : [],
  )

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={triggerClassName ?? 'size-9 shrink-0'}
          disabled={disabled}
          title="Emoji"
        >
          <SmileIcon className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="start">
        <p className="mb-2 px-1 text-xs font-medium text-muted-foreground">
          Emoji
        </p>
        <div className="grid max-h-40 grid-cols-8 gap-0.5 overflow-y-auto">
          {QUICK_REACTIONS.map((emoji) => (
            <Button
              key={emoji}
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 text-lg"
              onClick={() => onInsert(emoji)}
            >
              {emoji}
            </Button>
          ))}
        </div>
        {customEmojis.length > 0 ? (
          <>
            <p className="mb-2 mt-3 px-1 text-xs font-medium text-muted-foreground">
              Серверные
            </p>
            <div className="grid max-h-32 grid-cols-8 gap-0.5 overflow-y-auto">
              {customEmojis.map((emoji) => (
                <Button
                  key={emoji._id}
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  title={`:${emoji.name}:`}
                  onClick={() => onInsert(`:${emoji._id}:`)}
                >
                  <CustomEmoji emojiId={emoji._id} name={emoji.name} size="sm" />
                </Button>
              ))}
            </div>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
