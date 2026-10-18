import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Effect } from 'effect'
import { useTranslations, type Translator } from '@syrnike13/ui/i18n'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  LogOutIcon,
  XIcon,
} from '#/components/icons'

import {
  SettingsPanelContent,
  settingsSectionTitle,
} from '#/components/settings/settings-panels'
import { ProfileDraftProvider } from '#/components/settings/profile-draft-context'
import { ProfileUnsavedChangesBar } from '#/components/settings/profile-unsaved-changes-bar'
import {
  GENERAL_SETTINGS_NAV,
  resolveMobileSettingsStack,
  type MobileSettingsScreen,
} from '#/components/settings/settings-nav-config'
import { Button } from '@syrnike13/ui/primitives/button'
import { ScrollArea } from '@syrnike13/ui/primitives/scroll-area'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@syrnike13/ui/primitives/sheet'
import {
  type SettingsSection,
  useSettingsModal,
} from '#/features/settings/settings-modal-context'
import { useAuth } from '#/features/auth/auth-context'
import { cn } from '#/lib/utils'

const mobileNavRowClass =
  'h-auto w-full min-w-0 justify-start gap-3 px-3 py-3 text-left text-base'

function screenTitle(screen: MobileSettingsScreen, t: Translator) {
  if (screen.kind === 'general') return t('title')
  return settingsSectionTitle(screen.section, t)
}

export function SettingsMobileModal() {
  const t = useTranslations('settings')
  const auth = useAuth()
  const navigate = useNavigate()
  const { open, setOpen, section, setSection } = useSettingsModal()
  const [stack, setStack] = useState<MobileSettingsScreen[]>([
    { kind: 'general' },
  ])
  const [loggingOut, setLoggingOut] = useState(false)

  const currentScreen = stack[stack.length - 1] ?? { kind: 'general' as const }
  const showProfileBar =
    currentScreen.kind === 'section' && currentScreen.section === 'profile'

  useEffect(() => {
    if (!open) return
    setStack(resolveMobileSettingsStack(section))
  }, [open, section])

  function pushScreen(screen: MobileSettingsScreen) {
    setStack((prev) => [...prev, screen])
  }

  function handleBack() {
    if (stack.length <= 1) {
      setOpen(false)
      return
    }
    setStack((prev) => prev.slice(0, -1))
  }

  function openSection(next: SettingsSection) {
    setSection(next)
    pushScreen({ kind: 'section', section: next })
  }

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
    <Sheet
      open={open}
      onOpenChange={(nextOpen, details) => {
        // Escape pops the mobile settings stack before closing the sheet.
        if (
          !nextOpen &&
          details.reason === 'escape-key' &&
          stack.length > 1
        ) {
          details.cancel()
          setStack((prev) => prev.slice(0, -1))
          return
        }
        setOpen(nextOpen)
      }}
    >
      {/* design-allow restyle-shared: mobile settings sheet uses the settings surface */}
      <SheetContent
        side="right"
        showCloseButton={false}
        className="gradient-surface-solid z-300 gap-0 bg-card p-0 text-card-foreground shadow-none data-[side=right]:w-full data-[side=right]:border-l-0 data-[side=right]:max-w-none data-[side=right]:sm:max-w-none"
      >
        <SheetHeader className="shrink-0 gap-0 border-b border-border p-0">
          <div className="flex items-center gap-2 px-2 pb-3 safe-pt-3">
            {stack.length > 1 ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-10 shrink-0"
                onClick={handleBack}
                aria-label={t('back')}
              >
                <ChevronLeftIcon className="size-5" />
              </Button>
            ) : (
              <span className="size-10 shrink-0" aria-hidden />
            )}
            <SheetTitle className="min-w-0 flex-1 truncate text-center">
              {screenTitle(currentScreen, t)}
            </SheetTitle>
            <SheetClose
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-10 shrink-0"
                  aria-label={t('close')}
                />
              }
            >
              <XIcon className="size-5" />
            </SheetClose>
          </div>
        </SheetHeader>

        <ProfileDraftProvider>
          <div className="relative flex min-h-0 flex-1 flex-col">
            <ScrollArea className="min-h-0 flex-1">
              <div
                className={cn(
                  'px-4 py-4',
                  showProfileBar && 'pb-28',
                )}
              >
                {currentScreen.kind === 'general' ? (
                  <MobileGeneralSettingsMenu
                    onSelect={(id) => openSection(id)}
                    onLogout={() => void handleLogout()}
                    loggingOut={loggingOut}
                  />
                ) : null}

                {currentScreen.kind === 'section' ? (
                  <SettingsPanelContent section={currentScreen.section} />
                ) : null}
              </div>
            </ScrollArea>

            {showProfileBar ? (
              <ProfileUnsavedChangesBar className="inset-x-4 safe-bottom-3" />
            ) : null}
          </div>
        </ProfileDraftProvider>
      </SheetContent>
    </Sheet>
  )
}

function MobileGeneralSettingsMenu({
  onSelect,
  onLogout,
  loggingOut,
}: {
  onSelect: (section: SettingsSection) => void
  onLogout: () => void
  loggingOut: boolean
}) {
  const t = useTranslations('settings')

  return (
    <div className="flex flex-col gap-1">
      {GENERAL_SETTINGS_NAV.map((item) => {
        const Icon = item.icon

        return (
          <Button
            key={item.id}
            type="button"
            variant="ghost"
            className={mobileNavRowClass}
            onClick={() => onSelect(item.id)}
          >
            <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate">
              {t(item.labelKey)}
            </span>
            <ChevronRightIcon
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
          </Button>
        )
      })}

      <div className="mt-4 border-t border-border pt-2">
        <Button
          type="button"
          variant="destructive"
          className={mobileNavRowClass}
          disabled={loggingOut}
          onClick={onLogout}
        >
          <LogOutIcon className="size-5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            {loggingOut ? t('loggingOut') : t('logout')}
          </span>
        </Button>
      </div>
    </div>
  )
}
