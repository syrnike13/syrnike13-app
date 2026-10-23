import { useState } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'

import { Button } from '@syrnike13/ui/primitives/button'
import { Card, CardContent } from '@syrnike13/ui/primitives/card'
import { Label } from '@syrnike13/ui/primitives/label'
import { Switch } from '@syrnike13/ui/primitives/switch'
import {
  debugAchievementCopy,
  readAchievementAutoplay,
  showDebugAchievement,
  showDebugAchievementQueue,
  writeAchievementAutoplay,
} from '#/features/achievements/achievement-debug'
import { useAuth } from '#/features/auth/auth-context'

/** Ручная проверка уведомлений о получении бейджей. */
export function AchievementDebugView() {
  const t = useTranslations('achievements.debug')
  const badges = useAuth().user?.badges ?? []
  const [autoplay, setAutoplay] = useState(readAchievementAutoplay)

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 overflow-y-auto p-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">{t('title')}</h1>
        <p className="mt-1 max-w-xl text-sm text-muted-foreground">
          {t('description')}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => showDebugAchievement(debugAchievementCopy(t))}
        >
          {t('showTest')}
        </Button>
        <Button
          variant="secondary"
          onClick={() =>
            showDebugAchievementQueue(debugAchievementCopy(t), badges)
          }
        >
          {badges.length > 0
            ? t('showMine', { count: badges.length })
            : t('showQueue')}
        </Button>
      </div>

      <Card size="sm" className="max-w-xl">
        <CardContent className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <Label htmlFor="achievement-autoplay">{t('autoplay')}</Label>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('autoplayHint')}
            </p>
          </div>
          <Switch
            id="achievement-autoplay"
            checked={autoplay}
            onCheckedChange={(checked) => {
              writeAchievementAutoplay(checked)
              setAutoplay(checked)
            }}
          />
        </CardContent>
      </Card>
    </div>
  )
}
