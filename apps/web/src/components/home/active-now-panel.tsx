import { useId } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@syrnike13/ui/primitives/empty'

export function ActiveNowPanel() {
  const t = useTranslations('home.activeNow')
  const titleId = useId()

  return (
    <aside
      aria-labelledby={titleId}
      className="hidden w-90 shrink-0 flex-col border-l border-shell-divider xl:flex"
    >
      <div className="flex flex-col gap-4 p-4">
        <h2 id={titleId} className="text-xl font-bold">
          {t('title')}
        </h2>
        <Empty size="sm" variant="card">
          <EmptyHeader>
            <EmptyTitle>{t('soon')}</EmptyTitle>
            <EmptyDescription>{t('description')}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    </aside>
  )
}
