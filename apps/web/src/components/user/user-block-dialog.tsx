import type { User } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@syrnike13/ui/primitives/alert-dialog'

type UserBlockDialogProps = {
  user: User
  open: boolean
  busy?: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

export function UserBlockDialog({
  user,
  open,
  busy = false,
  onOpenChange,
  onConfirm,
}: UserBlockDialogProps) {
  const t = useTranslations('users')

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('confirmBan', { username: user.username })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('blockDescription')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t('cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            onClick={onConfirm}
          >
            {t('block')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
