import { Link } from '@tanstack/react-router'

import { APP_LOGO_SRC } from '#/lib/brand'
import { config } from '#/lib/config'

export function SiteHeader() {
  return (
    <header className="mx-auto flex w-full max-w-[1200px] items-center justify-between px-6 py-5">
      <Link to="/" className="flex items-center gap-2">
        <img
          src={APP_LOGO_SRC}
          alt=""
          className="size-7"
          width={28}
          height={28}
        />
        <span className="text-[15px] font-bold tracking-tight">
          {config.appTitle}
        </span>
      </Link>

      <Link
        to="/app"
        search={{ tab: 'online' }}
        className="rounded-full bg-foreground px-4 py-2 text-[13px] font-semibold text-background transition-opacity hover:opacity-90"
      >
        Открыть в браузере
      </Link>
    </header>
  )
}
