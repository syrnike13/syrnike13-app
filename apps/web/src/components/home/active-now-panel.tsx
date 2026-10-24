import { useId } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'

import { shellColumnHeaderClass } from '#/components/layout/shell-chrome'
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@syrnike13/ui/primitives/card'
import { cn } from '#/lib/utils'

export function ActiveNowPanel() {
  const t = useTranslations('home.activeNow')
  const titleId = useId()

  return (
    <aside
      aria-labelledby={titleId}
      className="hidden w-90 shrink-0 flex-col border-l border-shell-divider xl:flex"
    >
      <header className={cn(shellColumnHeaderClass, 'px-4')}>
        <h2 id={titleId} className="text-base font-semibold">
          {t('title')}
        </h2>
      </header>
      <div className="p-4">
        <Card size="sm">
          <CardHeader className="text-center">
            <CardTitle>{t('soon')}</CardTitle>
            <CardDescription>{t('description')}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    </aside>
  )
}
