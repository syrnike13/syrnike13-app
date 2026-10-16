import { useState } from 'react'

import { Button } from '#/components/ui/button'
import { Label } from '#/components/ui/label'
import { Switch } from '#/components/ui/switch'
import {
  readAchievementAutoplay,
  showDebugAchievement,
  showDebugAchievementQueue,
  writeAchievementAutoplay,
} from '#/features/achievements/achievement-debug'
import { useAuth } from '#/features/auth/auth-context'

/** Ручная проверка уведомлений о получении бейджей. */
export function AchievementDebugView() {
  const badges = useAuth().user?.badges ?? []
  const [autoplay, setAutoplay] = useState(readAchievementAutoplay)

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 overflow-y-auto p-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">
          Отладка достижений
        </h1>
        <p className="mt-1 max-w-xl text-sm text-muted-foreground">
          Уведомления ниже показываются только локально и ничего не меняют на
          сервере. Чтобы проверить настоящую выдачу, выдайте себе бейдж в
          админке: уведомление придёт через сервер.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => showDebugAchievement()}>
          Показать тестовое достижение
        </Button>
        <Button variant="secondary" onClick={() => showDebugAchievementQueue(badges)}>
          {badges.length > 0
            ? `Показать мои бейджи (${badges.length})`
            : 'Показать очередь из трёх'}
        </Button>
      </div>

      <div className="flex max-w-xl items-center justify-between gap-4 rounded-md border border-border bg-card p-4">
        <div className="min-w-0">
          <Label htmlFor="achievement-autoplay">Показывать при запуске</Label>
          <p className="mt-1 text-xs text-muted-foreground">
            Тестовое достижение появится через пару секунд после каждого
            запуска приложения на этом устройстве.
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
      </div>
    </div>
  )
}
