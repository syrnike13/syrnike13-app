import { PlusIcon } from '#/components/icons'

import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '#/components/ui/drawer'
import { PresencePickerList } from '#/components/user/presence-picker-list'
import { profileMenuRowClass } from '#/components/user/profile-menu-row'
import { cn } from '#/lib/utils'

type MobilePresenceDrawerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  customStatus?: string
  onEditCustomStatus: () => void
}

export function MobilePresenceDrawer({
  open,
  onOpenChange,
  customStatus,
  onEditCustomStatus,
}: MobilePresenceDrawerProps) {
  const statusLabel = customStatus?.trim()

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Статус</DrawerTitle>
          <DrawerDescription className="sr-only">
            Выберите режим присутствия или задайте текстовый статус
          </DrawerDescription>
        </DrawerHeader>

        <PresencePickerList onSelected={() => onOpenChange(false)} />

        <div className="mt-1 border-t border-shell-divider p-2">
          <button
            type="button"
            className={cn(
              profileMenuRowClass,
              'h-11 rounded-lg px-3 text-base text-foreground',
            )}
            onClick={() => {
              onOpenChange(false)
              onEditCustomStatus()
            }}
          >
            <PlusIcon className="size-4 shrink-0 opacity-70" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-left">
              {statusLabel ? `«${statusLabel}»` : 'Задать кастомный статус'}
            </span>
          </button>
        </div>
      </DrawerContent>
    </Drawer>
  )
}
