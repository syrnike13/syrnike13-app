import { createFileRoute } from '@tanstack/react-router'

const adminRedirectUrls = {
  'syrnike13.ru': 'https://admin.syrnike13.ru',
  'www.syrnike13.ru': 'https://admin.syrnike13.ru',
  'beta.syrnike13.ru': 'https://admin.beta.syrnike13.ru',
} as const

export function getAdminRedirectUrl(hostname: string) {
  return (
    adminRedirectUrls[hostname as keyof typeof adminRedirectUrls] ??
    'https://admin.syrnike13.ru'
  )
}

export const Route = createFileRoute('/admin')({
  component: AdminRedirect,
})

function AdminRedirect() {
  const target =
    typeof window === 'undefined'
      ? 'https://admin.syrnike13.ru'
      : getAdminRedirectUrl(window.location.hostname)

  if (typeof window !== 'undefined') {
    window.location.replace(target)
  }

  return (
    <main className="gradient-surface-content flex min-h-svh items-center justify-center bg-background px-6 text-sm text-muted-foreground">
      Переходим в админку...
    </main>
  )
}
