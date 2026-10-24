import { useTranslations } from '@syrnike13/ui/i18n'
import { SmileIcon } from '#/components/icons'

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

type ComposerEmojiPickerProps = {
  serverId?: string | null
  disabled?: boolean
  onInsert: (text: string) => void
}

export function ComposerEmojiPicker({
  serverId,
  disabled,
  onInsert,
}: ComposerEmojiPickerProps) {
  const t = useTranslations('chat')
  const customEmojis = useSyncStore((s) =>
    serverId ? listServerCustomEmojis(s, serverId) : [],
  )

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={disabled}
            title={t('emoji')}
            aria-label={t('emoji')}
          />
        }
      >
        <SmileIcon className="size-5" />
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="start">
        <p className="mb-2 px-1 text-xs font-medium text-muted-foreground">
          {t('emoji')}
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
              {t('serverEmojis')}
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
