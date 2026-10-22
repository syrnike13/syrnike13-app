import { useTranslations } from '@syrnike13/ui/i18n'

export function ActiveNowPanel() {
  const t = useTranslations('home.activeNow')

  return (
    <aside className="gradient-surface-content hidden w-60 shrink-0 flex-col border-l border-shell-divider bg-card xl:flex">
      <header className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{t('title')}</h2>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-sm font-medium text-muted-foreground">{t('soon')}</p>
        <p className="text-xs text-muted-foreground">{t('description')}</p>
      </div>
    </aside>
  )
}
