import '../global.css'

import { LocaleProvider } from '@syrnike13/ui/i18n'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useEffect, useMemo, useState } from 'react'
import { SafeAreaProvider, SafeAreaView as NativeSafeAreaView } from 'react-native-safe-area-context'
import { useResolveClassNames, withUniwind } from 'uniwind'

import { clearSession, loadSession, type Session } from '../auth/session'
import { SessionContext } from '../auth/session-context'
import { CallLayer } from '../call/call-layer'
import { VoicePreviewProvider } from '../call/voice-preview'
import { SyncProvider } from '../data/sync-provider'
import { catalogs } from '../messages'
import { LoginScreen } from '../screens/login-screen'
import { applyTheme } from '../theme'
import { UpdateBanner } from '../updates/update-banner'
import { VoiceProvider } from '../voice/voice-provider'

// Uniwind styles core components only; third-party ones need `withUniwind`.
const SafeAreaView = withUniwind(NativeSafeAreaView)

applyTheme({ colorMode: 'system' })

export default function RootLayout() {
  // `undefined` while the stored session is being read.
  const [session, setSession] = useState<Session | null | undefined>(undefined)

  useEffect(() => {
    void loadSession().then(setSession)
  }, [])

  const sessionValue = useMemo(
    () =>
      session
        ? {
            session,
            logout() {
              void clearSession().then(() => setSession(null))
            },
          }
        : null,
    [session],
  )

  return (
    <SafeAreaProvider>
      <LocaleProvider catalogs={catalogs}>
        <SafeAreaView edges={['top']} className="flex-1 bg-background">
          <UpdateBanner />
          {session === null ? <LoginScreen onLogin={setSession} /> : null}
          {sessionValue ? (
            <SessionContext.Provider value={sessionValue}>
              <SyncProvider token={sessionValue.session.token} userId={sessionValue.session.userId}>
                <VoiceProvider userId={sessionValue.session.userId}>
                  <CallLayer>
                    <VoicePreviewProvider>
                      <AppStack />
                    </VoicePreviewProvider>
                  </CallLayer>
                </VoiceProvider>
              </SyncProvider>
            </SessionContext.Provider>
          ) : null}
        </SafeAreaView>
        <StatusBar style="auto" />
      </LocaleProvider>
    </SafeAreaProvider>
  )
}

function AppStack() {
  const background = useResolveClassNames('bg-background')
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: background.backgroundColor as string | undefined },
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="channel/[channelId]" options={{ animation: 'slide_from_right' }} />
      <Stack.Screen name="notifications" options={{ animation: 'slide_from_right' }} />
      <Stack.Screen name="call" options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }} />
      <Stack.Screen name="profile" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
    </Stack>
  )
}
