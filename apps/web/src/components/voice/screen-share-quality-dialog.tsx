import { useState } from 'react'

import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Label } from '#/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
import {
  SCREEN_SHARE_QUALITY_LABELS,
  type ScreenShareQualityName,
} from '#/features/voice/voice-preference-types'

type ScreenShareQualityDialogProps = {
  open: boolean
  defaultQuality: ScreenShareQualityName
  defaultAudio: boolean
  onConfirm: (quality: ScreenShareQualityName, withAudio: boolean) => void
  onCancel: () => void
}

export function ScreenShareQualityDialog({
  open,
  defaultQuality,
  defaultAudio,
  onConfirm,
  onCancel,
}: ScreenShareQualityDialogProps) {
  const [quality, setQuality] = useState<ScreenShareQualityName>(defaultQuality)
  const [withAudio, setWithAudio] = useState(defaultAudio)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Демонстрация экрана</DialogTitle>
          <DialogDescription>
            Выберите качество трансляции. Её увидят участники голосового канала.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Качество</Label>
            <Select
              value={quality}
              onValueChange={(value) =>
                setQuality(value as ScreenShareQualityName)
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(SCREEN_SHARE_QUALITY_LABELS) as ScreenShareQualityName[]).map(
                  (name) => (
                    <SelectItem key={name} value={name}>
                      {SCREEN_SHARE_QUALITY_LABELS[name]}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 rounded border-input accent-primary"
              checked={withAudio}
              onChange={(event) => setWithAudio(event.target.checked)}
            />
            Передавать звук с экрана
          </label>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Отмена
          </Button>
          <Button
            type="button"
            onClick={() => onConfirm(quality, withAudio)}
          >
            Начать демонстрацию
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
