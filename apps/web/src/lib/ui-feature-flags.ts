import { config } from '#/lib/config'

/**
 * Единый каталог UI-возможностей, которые зависят от канала сборки.
 * Компоненты не должны самостоятельно читать env или releaseChannel.
 */
export const uiFeatureFlags = {
  /** Страница и команда для ручной проверки уведомлений о бейджах. */
  achievementDebug: import.meta.env.DEV || config.releaseChannel === 'nightly',
} as const
