import { createFileRoute, redirect } from '@tanstack/react-router'

import { AchievementDebugView } from '#/components/achievements/achievement-debug-view'
import { uiFeatureFlags } from '#/lib/ui-feature-flags'

export const Route = createFileRoute('/app/achievements-debug')({
  beforeLoad: () => {
    if (!uiFeatureFlags.achievementDebug) {
      throw redirect({ to: '/app', search: { tab: 'online' } })
    }
  },
  component: AchievementDebugView,
})
