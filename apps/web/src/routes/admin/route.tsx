import { createFileRoute } from '@tanstack/react-router'
import { useTranslations } from '@syrnike13/ui/i18n'

const adminRedirectUrls: Record<string, string> = {
  'app.syrnike13.ru': 'https://admin.syrnike13.ru',
  'syrnike13.ru': 'https://admin.syrnike13.ru',
  'www.syrnike13.ru': 'https://admin.syrnike13.ru',
  'app.beta.syrnike13.ru': 'https://admin.beta.syrnike13.ru',
  'beta.syrnike13.ru': 'https://admin.beta.syrnike13.ru',
}

export function getAdminRedirectUrl(hostname: string) {
  return (
    adminRedirectUrls[hostname] ??
    'https://admin.syrnike13.ru'
  )
}

export const Route = createFileRoute('/admin')({
  component: AdminRedirect,
})

function AdminRedirect() {
  const t = useTranslations('common')
  const target =
    typeof window === 'undefined'
      ? 'https://admin.syrnike13.ru'
      : getAdminRedirectUrl(window.location.hostname)

  if (typeof window !== 'undefined') {
    window.location.replace(target)
  }

  return (
    <main className="gradient-surface-content flex min-h-svh items-center justify-center bg-background px-6 text-sm text-muted-foreground">
      {t('adminRedirect')}
    </main>
  )
}
