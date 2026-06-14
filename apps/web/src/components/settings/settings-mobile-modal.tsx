import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from '@tanstack/react-router'
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
import { Button } from '#/components/ui/button'
import { ScrollArea } from '#/components/ui/scroll-area'
import {
  type SettingsSection,
  useSettingsModal,
} from '#/features/settings/settings-modal-context'
import { useAuth } from '#/features/auth/auth-context'
import { cn } from '#/lib/utils'

function mobileNavRowClass(active = false) {
  return cn(
    'flex w-full min-w-0 items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors',
    active
      ? 'bg-accent text-accent-foreground'
      : 'text-foreground hover:bg-accent/50',
  )
}

function screenTitle(screen: MobileSettingsScreen) {
  if (screen.kind === 'general') return 'Настройки'
  return settingsSectionTitle(screen.section)
}

export function SettingsMobileModal() {
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

  useEffect(() => {
    if (!open) return

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [open])

  useEffect(() => {
    if (!open) return

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setStack((prev) => {
        if (prev.length > 1) return prev.slice(0, -1)
        setOpen(false)
        return prev
      })
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, setOpen])

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

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[300] flex flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-2 pb-3 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)]">
        {stack.length > 1 ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-10 shrink-0"
            onClick={handleBack}
            aria-label="Назад"
          >
            <ChevronLeftIcon className="size-5" />
          </Button>
        ) : (
          <span className="size-10 shrink-0" aria-hidden />
        )}
        <h1 className="min-w-0 flex-1 truncate text-center text-base font-semibold">
          {screenTitle(currentScreen)}
        </h1>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-10 shrink-0"
          onClick={() => setOpen(false)}
          aria-label="Закрыть"
        >
          <XIcon className="size-5" />
        </Button>
      </header>

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
            <ProfileUnsavedChangesBar className="inset-x-4 bottom-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]" />
          ) : null}
        </div>
      </ProfileDraftProvider>
    </div>,
    document.body,
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
  return (
    <div className="flex flex-col gap-1">
      {GENERAL_SETTINGS_NAV.map((item) => {
        const Icon = item.icon

        return (
          <button
            key={item.id}
            type="button"
            className={mobileNavRowClass()}
            onClick={() => onSelect(item.id)}
          >
            <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-base">
              {item.label}
            </span>
            <ChevronRightIcon
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
          </button>
        )
      })}

      <div className="mt-4 border-t border-border pt-2">
        <button
          type="button"
          className={cn(
            mobileNavRowClass(),
            'text-destructive hover:bg-destructive/10 hover:text-destructive',
          )}
          disabled={loggingOut}
          onClick={onLogout}
        >
          <LogOutIcon className="size-5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-base">
            {loggingOut ? 'Выход…' : 'Выйти'}
          </span>
        </button>
      </div>
    </div>
  )
}
