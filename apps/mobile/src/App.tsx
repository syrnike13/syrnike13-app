import './global.css'

import { LocaleProvider, useTranslations } from '@syrnike13/ui/i18n'
import { listThemes } from '@syrnike13/ui/tokens'
import { Button } from '@syrnike13/ui-native/primitives/button'
import { Text } from '@syrnike13/ui-native/primitives/text'
import { StatusBar } from 'expo-status-bar'
import { useState } from 'react'
import { View } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'

import { catalogs } from './messages'
import { applyTheme } from './theme'

applyTheme({ colorMode: 'system' })

/** Scaffold screen: checks shared i18n, Prism themes and native primitives. */
function ThemePreview() {
  const t = useTranslations('mobile.preview')
  const themes = listThemes()
  const [index, setIndex] = useState(0)

  function nextTheme() {
    const next = (index + 1) % themes.length
    setIndex(next)
    applyTheme({ colorMode: 'system', themeId: themes[next]!.id })
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-1 justify-center gap-4 px-4">
        <Text className="text-2xl font-semibold">{t('title')}</Text>
        <Text className="text-muted-foreground">
          {t('theme', { name: themes[index]!.id })}
        </Text>
        <View className="flex-row flex-wrap gap-2">
          <Button onPress={nextTheme}>
            <Text>{t('nextTheme')}</Text>
          </Button>
          <Button variant="secondary">
            <Text>{t('secondary')}</Text>
          </Button>
          <Button variant="outline">
            <Text>{t('outline')}</Text>
          </Button>
          <Button variant="destructive">
            <Text>{t('destructive')}</Text>
          </Button>
        </View>
      </View>
      <StatusBar style="auto" />
    </SafeAreaView>
  )
}

export function App() {
  return (
    <SafeAreaProvider>
      <LocaleProvider catalogs={catalogs}>
        <ThemePreview />
      </LocaleProvider>
    </SafeAreaProvider>
  )
}
