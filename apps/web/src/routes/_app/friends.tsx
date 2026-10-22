import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/friends')({
  beforeLoad: () => {
    throw redirect({
      to: '/',
      search: { tab: 'all' },
    })
  },
})
