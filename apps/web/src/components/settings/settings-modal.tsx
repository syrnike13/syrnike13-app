import {
  BellIcon,
  AppWindowIcon,
  MonitorIcon,
  PaletteIcon,
  PencilIcon,
  Volume2Icon,
  SearchIcon,
  XIcon,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import {
  SettingsPanelContent,
  settingsSectionTitle,
} from '#/components/settings/settings-panels'
import { UserAvatar } from '#/components/user/user-avatar'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { ScrollArea } from '#/components/ui/scroll-area'
import {
  type SettingsSection,
  useSettingsModal,
} from '#/features/settings/settings-modal-context'
import { useAuth } from '#/features/auth/auth-context'
import { usePlatform } from '#/platform/use-platform'
import { cn } from '#/lib/utils'

function settingsNavItemClass(active: boolean) {
  return cn(
    'flex w-full items-center gap-2 rounded-md text-left text-sm transition-colors',
    active
      ? 'bg-accent font-medium text-accent-foreground'
      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
  )
}

const NAV: {
  id: Exclude<SettingsSection, 'profile'>
  label: string
  icon: LucideIcon
}[] = [
  { id: 'account', label: 'Аккаунт', icon: PencilIcon },
  { id: 'voice', label: 'Голос и видео', icon: Volume2Icon },
  { id: 'sessions', label: 'Устройства', icon: MonitorIcon },
  { id: 'notifications', label: 'Уведомления', icon: BellIcon },
  { id: 'appearance', label: 'Оформление', icon: PaletteIcon },
]

const DESKTOP_NAV_ITEM = {
  id: 'desktop' as const,
  label: 'Приложение',
  icon: AppWindowIcon,
}

export function SettingsModal() {
  const auth = useAuth()
  const { open, setOpen, section, setSection } = useSettingsModal()
  const user = auth.user
  const { isDesktop } = usePlatform()
  const navItems = isDesktop ? [...NAV, DESKTOP_NAV_ITEM] : NAV

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          'flex h-[min(85vh,640px)] max-h-[min(90vh,640px)] w-[min(960px,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] gap-0 overflow-hidden p-0',
          'sm:max-w-[min(960px,calc(100vw-2rem))]',
        )}
      >
        <DialogTitle className="sr-only">Настройки пользователя</DialogTitle>
        <DialogDescription className="sr-only">
          Параметры аккаунта, уведомлений и оформления
        </DialogDescription>

        <aside className="flex w-[218px] shrink-0 flex-col border-r border-border bg-muted">
          <div className="border-b border-border/60 p-3">
            <button
              type="button"
              className={cn(
                'flex w-full items-center gap-2 rounded-lg p-1.5 text-left transition-colors',
                section === 'profile'
                  ? 'bg-accent ring-1 ring-border/60'
                  : 'hover:bg-accent/50',
              )}
              onClick={() => setSection('profile')}
            >
              <UserAvatar
                user={user}
                className="size-10"
                fallbackClassName="size-10"
                showPresence={false}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-muted-foreground">
                  @{user?.username}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Редактировать
                </p>
              </div>
            </button>
            <div className="relative mt-3">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                disabled
                placeholder="Поиск — скоро"
                className="h-8 bg-background/60 pl-8 text-xs"
              />
            </div>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <nav className="flex flex-col gap-0.5 p-2">
              <p className="px-2 py-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                Настройки пользователя
              </p>
              {navItems.map((item) => {
                const Icon = item.icon
                const active = section === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={cn(settingsNavItemClass(active), 'h-9 px-2')}
                    onClick={() => setSection(item.id)}
                  >
                    <Icon className="size-4 shrink-0" />
                    {item.label}
                  </button>
                )
              })}
            </nav>
          </ScrollArea>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col bg-background">
          <header className="flex shrink-0 items-center justify-between border-b border-border px-6 py-4">
            <h2 className="text-xl font-semibold">
              {settingsSectionTitle(section)}
            </h2>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={() => setOpen(false)}
            >
              <XIcon className="size-4" />
              <span className="sr-only">Закрыть</span>
            </Button>
          </header>

          <ScrollArea className="min-h-0 flex-1">
            <div className="px-6 py-2 pb-8">
              <SettingsPanelContent section={section} />
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  )
}
