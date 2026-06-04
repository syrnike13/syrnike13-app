import { createFileRoute } from '@tanstack/react-router'

import { DiscoverFrame } from '#/components/discover/discover-frame'

export const Route = createFileRoute('/app/discover')({
  component: DiscoverRoute,
})

function DiscoverRoute() {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="border-b px-4 py-3">
        <h1 className="text-lg font-semibold">Discover</h1>
        <p className="text-sm text-muted-foreground">
          Публичные серверы и сообщества
        </p>
      </header>
      <DiscoverFrame />
    </div>
  )
}
