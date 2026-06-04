import { VolumeXIcon } from 'lucide-react'

import {
  ContextMenuCheckboxItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from '#/components/ui/context-menu'
import { Slider } from '#/components/ui/slider'
import {
  formatUserVolumeLabel,
  VOICE_USER_VOLUME_MAX,
  voiceListenerStore,
  useVoiceListenerStore,
} from '#/features/voice/voice-listener-store'

type UserContextMenuVoiceControlsProps = {
  userId: string
}

export function UserContextMenuVoiceControls({
  userId,
}: UserContextMenuVoiceControlsProps) {
  const volume = useVoiceListenerStore((s) => s.getUserVolume(userId))
  const muted = useVoiceListenerStore((s) => s.getUserMuted(userId))

  return (
    <>
      <div
        className="px-2 py-2"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <ContextMenuLabel className="px-0 pb-2 text-xs text-muted-foreground">
          Громкость пользователя
        </ContextMenuLabel>
        <div className="flex items-center gap-2">
          <Slider
            className="flex-1"
            min={0}
            max={VOICE_USER_VOLUME_MAX}
            step={0.1}
            value={[volume]}
            onValueChange={([next]) => {
              voiceListenerStore.setUserVolume(userId, next)
            }}
          />
          <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
            {formatUserVolumeLabel(volume)}
          </span>
        </div>
      </div>
      <ContextMenuCheckboxItem
        checked={muted}
        onSelect={(event) => event.preventDefault()}
        onCheckedChange={(checked) => {
          voiceListenerStore.setUserMuted(userId, checked === true)
        }}
      >
        <VolumeXIcon />
        Заглушить для меня
      </ContextMenuCheckboxItem>
      <ContextMenuSeparator />
    </>
  )
}
