import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/app/friends')({
  beforeLoad: () => {
    throw redirect({
      to: '/app',
      search: { tab: 'all' },
    })
  },
})
