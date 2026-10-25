import { createFileRoute } from '@tanstack/react-router'

import { HOME_TABS, HomeView, type HomeTab } from '#/components/home/home-view'

function isHomeTab(value: unknown): value is HomeTab {
  return typeof value === 'string' && HOME_TABS.some((tab) => tab === value)
}

function parseTab(value: unknown): HomeTab {
  return isHomeTab(value) ? value : 'online'
}

export const Route = createFileRoute('/_app/')({
  validateSearch: (search: Record<string, unknown>) => ({
    tab: parseTab(search.tab),
  }),
  component: AppIndexPage,
})

function AppIndexPage() {
  const { tab } = Route.useSearch()
  return <HomeView tab={tab} />
}
