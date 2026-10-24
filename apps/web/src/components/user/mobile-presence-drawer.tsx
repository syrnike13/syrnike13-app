import { PlusIcon } from '#/components/icons'
import { useTranslations } from '@syrnike13/ui/i18n'

import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@syrnike13/ui/primitives/drawer'
import { PresencePickerList } from '#/components/user/presence-picker-list'
import { SidebarMenuButton } from '@syrnike13/ui/primitives/sidebar'

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
  const t = useTranslations('users')
  const statusLabel = customStatus?.trim()

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('status')}</DrawerTitle>
          <DrawerDescription className="sr-only">
            {t('presenceDescription')}
          </DrawerDescription>
        </DrawerHeader>

        <PresencePickerList onSelected={() => onOpenChange(false)} />

        <div className="mt-1 border-t border-shell-divider p-2">
          <SidebarMenuButton
            size="lg"
            onClick={() => {
              onOpenChange(false)
              onEditCustomStatus()
            }}
          >
            <PlusIcon aria-hidden />
            <span className="min-w-0 flex-1 truncate text-foreground">
              {statusLabel ? `«${statusLabel}»` : t('customStatus')}
            </span>
          </SidebarMenuButton>
        </div>
      </DrawerContent>
    </Drawer>
  )
}
