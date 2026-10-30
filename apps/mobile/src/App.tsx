import './global.css'

import { LocaleProvider } from '@syrnike13/ui/i18n'
import { StatusBar } from 'expo-status-bar'
import { useEffect, useState } from 'react'
import {
  SafeAreaProvider,
  SafeAreaView as NativeSafeAreaView,
} from 'react-native-safe-area-context'
import { withUniwind } from 'uniwind'

import { clearSession, loadSession, type Session } from './auth/session'
import { catalogs } from './messages'
import { LoginScreen } from './screens/login-screen'
import { VoiceScreen } from './screens/voice-screen'
import { applyTheme } from './theme'

// Uniwind styles core components only; third-party ones need `withUniwind`.
const SafeAreaView = withUniwind(NativeSafeAreaView)

applyTheme({ colorMode: 'system' })

export function App() {
  // `undefined` while the stored session is being read.
  const [session, setSession] = useState<Session | null | undefined>(undefined)

  useEffect(() => {
    void loadSession().then(setSession)
  }, [])

  async function logout() {
    await clearSession()
    setSession(null)
  }

  return (
    <SafeAreaProvider>
      <LocaleProvider catalogs={catalogs}>
        <SafeAreaView className="flex-1 bg-background">
          {session === null ? <LoginScreen onLogin={setSession} /> : null}
          {session ? <VoiceScreen token={session.token} onLogout={logout} /> : null}
        </SafeAreaView>
        <StatusBar style="auto" />
      </LocaleProvider>
    </SafeAreaProvider>
  )
}
