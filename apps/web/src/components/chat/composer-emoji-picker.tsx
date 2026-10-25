import { useTranslations } from '@syrnike13/ui/i18n'
import { SmileIcon } from '#/components/icons'

import { EmojiPicker } from '#/components/emoji/emoji-picker'
import { Button } from '@syrnike13/ui/primitives/button'
import { isCustomEmojiId } from '#/lib/emoji'

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

  return (
    <EmojiPicker
      serverId={serverId}
      onPick={(emoji) => onInsert(isCustomEmojiId(emoji) ? `:${emoji}:` : emoji)}
      trigger={
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={disabled}
          title={t('emoji')}
          aria-label={t('emoji')}
        >
          <SmileIcon className="size-5" />
        </Button>
      }
    />
  )
}
