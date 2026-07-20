import { config } from '#/lib/config'

/**
 * Единый каталог UI-возможностей, которые зависят от канала сборки.
 * Компоненты не должны самостоятельно читать env или releaseChannel.
 */
export const uiFeatureFlags = {
  channelActivities: config.releaseChannel === 'nightly',
} as const
