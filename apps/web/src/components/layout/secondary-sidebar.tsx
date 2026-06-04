import { Link, useMatch } from '@tanstack/react-router'
import { SettingsIcon, UsersIcon } from 'lucide-react'

import { USER_PANEL_RESERVE_PX } from '#/components/layout/left-sidebar-stack'
import { shellDivider, shellNavSurface } from '#/components/layout/shell-chrome'
import { Button } from '#/components/ui/button'
import { useSettingsModal } from '#/features/settings/settings-modal-context'
import { cn } from '#/lib/utils'

export function SecondarySidebar() {
  const discoverMatch = useMatch({
    from: '/app/discover',
    shouldThrow: false,
  })
  const { openSettings } = useSettingsModal()

  return (
    <aside
      className={`flex h-full min-h-0 w-full flex-col ${shellNavSurface}`}
      style={{ paddingBottom: USER_PANEL_RESERVE_PX }}
    >
      <div className={`border-b px-4 py-3 ${shellDivider}`}>
        <h2 className="truncate text-sm font-semibold">
          {discoverMatch ? 'Discover' : 'Приложение'}
        </h2>
      </div>

      <nav className="flex flex-col gap-0.5 p-2">
        <Button
          variant="ghost"
          className={cn('h-9 justify-start gap-2 px-2 font-normal')}
          asChild
        >
          <Link to="/app" search={{ tab: 'online' }}>
            <UsersIcon className="size-4 shrink-0" />
            Главная
          </Link>
        </Button>
        <Button
          variant="ghost"
          className={cn('h-9 justify-start gap-2 px-2 font-normal')}
          onClick={() => openSettings('account')}
        >
          <SettingsIcon className="size-4 shrink-0" />
          Настройки
        </Button>
      </nav>
    </aside>
  )
}
