import { useTranslations } from '@syrnike13/ui/i18n'
import { Button } from '@syrnike13/ui-native/primitives/button'
import { Text } from '@syrnike13/ui-native/primitives/text'
import * as Application from 'expo-application'
import * as Updates from 'expo-updates'
import { useEffect, useState } from 'react'
import { View } from 'react-native'

import { AppUpdate } from '../../modules/app-update'
import { APK_FEED_URL } from '../config'

type ApkRelease = { version: string; versionCode: number; url: string; sha256: string }

/** A newer APK than this one, when the release feed has it. Dev builds never update. */
function useApkRelease() {
  const [release, setRelease] = useState<ApkRelease | null>(null)
  useEffect(() => {
    if (__DEV__) return
    const installed = Number(Application.nativeBuildVersion)
    fetch(APK_FEED_URL, { cache: 'no-store' })
      .then((response) => (response.ok ? (response.json() as Promise<ApkRelease>) : null))
      .then((latest) => {
        if (latest && latest.versionCode > installed) setRelease(latest)
      })
      .catch(() => {
        // Offline or no feed yet: check again on the next launch.
      })
  }, [])
  return release
}

/**
 * Offers the two kinds of updates: a JS update already downloaded over the air
 * (applied by reloading) and a new APK for native changes (installed by Android).
 */
export function UpdateBanner() {
  const t = useTranslations('mobile.updates')
  const { isUpdatePending } = Updates.useUpdates()
  const release = useApkRelease()
  const [state, setState] = useState<'idle' | 'downloading' | 'failed'>('idle')

  async function install(apk: ApkRelease) {
    if (!AppUpdate.canInstall()) return AppUpdate.openInstallSettings()
    setState('downloading')
    try {
      await AppUpdate.downloadAndInstall(apk.url, apk.sha256)
      setState('idle')
    } catch {
      setState('failed')
    }
  }

  if (release) {
    return (
      <View className="flex-row items-center gap-3 border-b border-border bg-card px-4 py-2">
        <Text className="flex-1 text-sm">
          {t(state === 'failed' ? 'apkFailed' : 'apkAvailable', { version: release.version })}
        </Text>
        <Button size="sm" disabled={state === 'downloading'} onPress={() => install(release)}>
          <Text>{t(state === 'downloading' ? 'downloading' : 'install')}</Text>
        </Button>
      </View>
    )
  }
  if (isUpdatePending) {
    return (
      <View className="flex-row items-center gap-3 border-b border-border bg-card px-4 py-2">
        <Text className="flex-1 text-sm">{t('otaReady')}</Text>
        <Button size="sm" onPress={() => void Updates.reloadAsync()}>
          <Text>{t('restart')}</Text>
        </Button>
      </View>
    )
  }
  return null
}
