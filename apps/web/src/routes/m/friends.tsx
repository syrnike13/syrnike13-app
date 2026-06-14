import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/m/friends')({
  beforeLoad: () => {
    throw redirect({
      to: '/m',
      search: { tab: 'all' },
    })
  },
})
