import { createFileRoute } from '@tanstack/react-router'

import { HomeView, type HomeTab } from '#/components/home/home-view'

const HOME_TABS = ['online', 'all', 'pending'] as const satisfies readonly HomeTab[]

function isHomeTab(value: unknown): value is HomeTab {
  return typeof value === 'string' && HOME_TABS.some((tab) => tab === value)
}

function parseTab(value: unknown): HomeTab {
  return isHomeTab(value) ? value : 'online'
}

export const Route = createFileRoute('/m/')({
  validateSearch: (search: Record<string, unknown>) => ({
    tab: parseTab(search.tab),
  }),
  component: MobileIndexPage,
})

function MobileIndexPage() {
  const { tab } = Route.useSearch()
  return <HomeView tab={tab} />
}
