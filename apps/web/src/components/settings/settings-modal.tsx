import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  BellIcon,
  AppWindowIcon,
  KeyboardIcon,
  LogOutIcon,
  MonitorIcon,
  PaletteIcon,
  PencilFillIcon,
  Volume2Icon,
  SearchIcon,
  XIcon,
} from '#/components/icons'
import type { AppIcon } from '#/components/icons'

import {
  SettingsPanelContent,
  settingsSectionTitle,
} from '#/components/settings/settings-panels'
import { ProfileDraftProvider } from '#/components/settings/profile-draft-context'
import { ProfileUnsavedChangesBar } from '#/components/settings/profile-unsaved-changes-bar'
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
  icon: AppIcon
}[] = [
  { id: 'account', label: 'Аккаунт', icon: PencilFillIcon },
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

const DESKTOP_ONLY_NAV_ITEMS = [
  {
    id: 'hotkeys' as const,
    label: 'Горячие клавиши',
    icon: KeyboardIcon,
  },
  DESKTOP_NAV_ITEM,
]

export function SettingsModal() {
  const auth = useAuth()
  const navigate = useNavigate()
  const { open, setOpen, section, setSection } = useSettingsModal()
  const user = auth.user
  const { isDesktop } = usePlatform()
  const navItems = isDesktop ? [...NAV, ...DESKTOP_ONLY_NAV_ITEMS] : NAV
  const [loggingOut, setLoggingOut] = useState(false)

  async function handleLogout() {
    if (loggingOut) return
    setLoggingOut(true)
    setOpen(false)
    try {
      await auth.logout()
      await navigate({ to: '/login', replace: true })
    } finally {
      setLoggingOut(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          'flex h-[calc(100vh-2rem)] max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-6xl gap-0 overflow-hidden p-0 sm:max-w-6xl',
        )}
      >
        <DialogTitle className="sr-only">Настройки пользователя</DialogTitle>
        <DialogDescription className="sr-only">
          Параметры аккаунта, уведомлений и оформления
        </DialogDescription>

        <aside className="flex min-h-0 w-[218px] shrink-0 flex-col border-r border-border bg-muted">
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

          <ScrollArea className="h-0 min-h-0 flex-1">
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
              <div className="mt-2 border-t border-border/60 pt-2">
                <button
                  type="button"
                  className={cn(
                    settingsNavItemClass(false),
                    'h-9 px-2 text-destructive hover:bg-destructive/10 hover:text-destructive',
                  )}
                  disabled={loggingOut}
                  onClick={() => void handleLogout()}
                >
                  <LogOutIcon className="size-4 shrink-0" />
                  {loggingOut ? 'Выход…' : 'Выйти'}
                </button>
              </div>
            </nav>
          </ScrollArea>
        </aside>

        <ProfileDraftProvider>
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
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

            <ScrollArea className="h-0 min-h-0 flex-1">
              <div
                className={cn(
                  'mx-auto w-full max-w-3xl px-6 py-2',
                  section === 'profile' ? 'pb-28' : 'pb-8',
                )}
              >
                <SettingsPanelContent section={section} />
              </div>
            </ScrollArea>

            {section === 'profile' ? <ProfileUnsavedChangesBar /> : null}
          </div>
        </ProfileDraftProvider>
      </DialogContent>
    </Dialog>
  )
}
