import { useState } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { Effect } from 'effect'
import { useTranslations } from '@syrnike13/ui/i18n'
import {
  AppWindowIcon,
  Gamepad2Icon,
  KeyboardIcon,
  LogOutIcon,
  SearchIcon,
  XIcon,
} from '#/components/icons'

import {
  SettingsPanelContent,
  settingsSectionTitle,
} from '#/components/settings/settings-panels'
import { ProfileDraftProvider } from '#/components/settings/profile-draft-context'
import { ProfileUnsavedChangesBar } from '#/components/settings/profile-unsaved-changes-bar'
import { GENERAL_SETTINGS_NAV } from '#/components/settings/settings-nav-config'
import { SettingsMobileModal } from '#/components/settings/settings-mobile-modal'
import { UserAvatar } from '#/components/user/user-avatar'
import { Button } from '@syrnike13/ui/primitives/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@syrnike13/ui/primitives/dialog'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@syrnike13/ui/primitives/input-group'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from '@syrnike13/ui/primitives/sidebar'
import { ScrollArea } from '@syrnike13/ui/primitives/scroll-area'
import {
  type SettingsSection,
  useSettingsModal,
} from '#/features/settings/settings-modal-context'
import { useAuth } from '#/features/auth/auth-context'
import { usePlatform } from '#/platform/use-platform'
import { cn } from '#/lib/utils'

const DESKTOP_NAV_ITEM: {
  id: SettingsSection
  labelKey: string
  icon: typeof AppWindowIcon
} = {
  id: 'desktop',
  labelKey: 'sections.desktop',
  icon: AppWindowIcon,
}

const DESKTOP_ONLY_NAV_ITEMS: {
  id: SettingsSection
  labelKey: string
  icon: typeof AppWindowIcon
}[] = [
  {
    id: 'hotkeys',
    labelKey: 'sections.hotkeys',
    icon: KeyboardIcon,
  },
  {
    id: 'overlay',
    labelKey: 'sections.overlay',
    icon: Gamepad2Icon,
  },
  DESKTOP_NAV_ITEM,
]

/**
 * Модалка настроек.
 *
 * Вариант (desktop/mobile) выбирается по текущему пути: `/m/*` → mobile,
 * иначе — desktop. Раньше использовался `useIsCompact`, но после разделения
 * роутов каждая зона знает свой shell, и проверка media query избыточна.
 */
export function SettingsModal() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  if (pathname.startsWith('/m')) {
    return <SettingsMobileModal />
  }
  return <SettingsDesktopModal />
}

function SettingsDesktopModal() {
  const t = useTranslations('settings')
  const auth = useAuth()
  const navigate = useNavigate()
  const { open, setOpen, section, setSection } = useSettingsModal()
  const user = auth.user
  const { isDesktop } = usePlatform()
  const navItems = isDesktop
    ? [...GENERAL_SETTINGS_NAV, ...DESKTOP_ONLY_NAV_ITEMS]
    : GENERAL_SETTINGS_NAV
  const [loggingOut, setLoggingOut] = useState(false)

  function handleLogout() {
    if (loggingOut) return
    setLoggingOut(true)
    setOpen(false)
    Effect.runFork(
      auth.logout().pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () => navigate({ to: '/login', replace: true }),
            catch: (cause) => cause,
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            setLoggingOut(false)
          }),
        ),
        Effect.ignore,
      ),
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        size="page"
        className="flex"
      >
        <DialogTitle className="sr-only">{t('userSettingsTitle')}</DialogTitle>
        <DialogDescription className="sr-only">
          {t('userSettingsDescription')}
        </DialogDescription>

        <aside className="flex min-h-0 w-54.5 shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground">
          <div className="flex flex-col gap-3 p-3">
            <SidebarMenuButton
              size="xl"
              isActive={section === 'profile'}
              onClick={() => setSection('profile')}
            >
              <UserAvatar
                user={user}
                className="size-10"
                fallbackClassName="size-10"
                showPresence={false}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate leading-5 font-semibold text-foreground">
                  {user?.display_name ?? user?.username}
                </span>
                <span className="truncate text-sm leading-4.5 text-muted-foreground">
                  {t('edit')}
                </span>
              </span>
            </SidebarMenuButton>
            <InputGroup size="sm">
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput disabled placeholder={t('searchSoon')} />
            </InputGroup>
          </div>

          <ScrollArea className="h-0 min-h-0 flex-1">
            <SidebarMenu className="p-2">
              {navItems.map((item) => {
                const Icon = item.icon
                return (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      size="md"
                      isActive={section === item.id}
                      aria-current={section === item.id ? 'page' : undefined}
                      onClick={() => setSection(item.id)}
                    >
                      <Icon />
                      <span>{t(item.labelKey)}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
              <SidebarSeparator className="my-2" />
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="md"
                  variant="destructive"
                  disabled={loggingOut}
                  onClick={() => void handleLogout()}
                >
                  <LogOutIcon />
                  <span>{loggingOut ? t('loggingOut') : t('logout')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </ScrollArea>
        </aside>

        <ProfileDraftProvider>
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-card text-card-foreground">
            <header className="flex shrink-0 items-center justify-between border-b border-border px-6 py-2">
              <h2 className="text-base font-semibold">
                {settingsSectionTitle(section, t)}
              </h2>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                shape="circle"
                onClick={() => setOpen(false)}
              >
                <XIcon />
                <span className="sr-only">{t('close')}</span>
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
