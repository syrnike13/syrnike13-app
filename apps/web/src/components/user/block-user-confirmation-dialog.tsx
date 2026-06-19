import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'

type BlockUserConfirmationDialogProps = {
  open: boolean
  username: string
  disabled?: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

export function BlockUserConfirmationDialog({
  open,
  username,
  disabled = false,
  onOpenChange,
  onConfirm,
}: BlockUserConfirmationDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Заблокировать @{username}?</DialogTitle>
          <DialogDescription>
            Пользователь не сможет писать вам сообщения и отправлять заявки в
            друзья.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() => onOpenChange(false)}
          >
            Отмена
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={disabled}
            onClick={onConfirm}
          >
            Заблокировать
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
