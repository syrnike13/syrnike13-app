import { createFileRoute } from '@tanstack/react-router'

import { HomeView, type HomeTab } from '#/components/home/home-view'

const HOME_TABS = new Set<HomeTab>(['online', 'all', 'pending'])

function parseTab(value: unknown): HomeTab {
  if (typeof value === 'string' && HOME_TABS.has(value as HomeTab)) {
    return value as HomeTab
  }
  return 'online'
}

export const Route = createFileRoute('/app/')({
  validateSearch: (search: Record<string, unknown>) => ({
    tab: parseTab(search.tab),
  }),
  component: AppIndexPage,
})

function AppIndexPage() {
  const { tab } = Route.useSearch()
  return <HomeView tab={tab} />
}
